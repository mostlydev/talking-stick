import stringWidth from "string-width";
import type { RoomEvent } from "../types.js";
import {
  formatChatEvent,
  formatChatStatus,
  type ChatFormatContext,
  type ChatStatusInput
} from "./chat-format.js";

// Pure screen model for the full-screen `tt chat` console. Nothing here reads
// input or writes to a terminal: chat.ts feeds events and keys in and writes
// the frames this module produces.

export const CHAT_PROMPT = "> ";
export const MAX_COMPOSER_ROWS = 5;
export const MAX_TRANSCRIPT_BLOCKS = 2_000;
const MAX_MENU_ROWS = 3;

export interface ChatCommandInfo {
  name: string;
  usage: string;
  description: string;
}

export const CHAT_COMMANDS: ChatCommandInfo[] = [
  { name: "quit", usage: "/quit", description: "leave the chat" },
  { name: "who", usage: "/who", description: "members and who has the stick" },
  {
    name: "to",
    usage: "/to <agent> <text>",
    description: "message matching agents (same as @agent)"
  },
  {
    name: "interrupt",
    usage: "/interrupt [@agent] <text>",
    description: "urgent message that wakes the recipient"
  },
  {
    name: "events",
    usage: "/events",
    description: "show or hide stick events"
  },
  {
    name: "bottom",
    usage: "/bottom",
    description: "jump to the latest messages"
  },
  { name: "help", usage: "/help", description: "list commands and keys" }
];

// ---------------------------------------------------------------------------
// Text measurement and wrapping

const SGR_PATTERN = /\u001b\[[0-9;]*m/y;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function graphemeWidth(grapheme: string): number {
  return stringWidth(grapheme);
}

export function textWidth(text: string): number {
  let width = 0;
  for (const cell of toCells(text)) {
    width += cell.width;
  }
  return width;
}

interface Cell {
  text: string;
  width: number;
  // SGR escapes active for this cell, accumulated since the last reset.
  style: string;
}

function toCells(text: string): Cell[] {
  const cells: Cell[] = [];
  let style = "";
  let index = 0;
  while (index < text.length) {
    SGR_PATTERN.lastIndex = index;
    const match = SGR_PATTERN.exec(text);
    if (match) {
      const reset = match[0] === "\u001b[0m" || match[0] === "\u001b[m";
      style = reset ? "" : style + match[0];
      index += match[0].length;
      continue;
    }
    // Plain text runs to the next escape; a stray non-SGR escape byte is
    // consumed on its own and dropped as a zero-width cell.
    const nextEscape = text.indexOf("\u001b", index + 1);
    const end = nextEscape === -1 ? text.length : nextEscape;
    const chunk = text.slice(index, end);
    for (const { segment } of graphemes.segment(chunk)) {
      const width = graphemeWidth(segment);
      if (width === 0 && cells.length > 0 && segment.codePointAt(0)! >= 0x20) {
        // Attach combining marks to the preceding cell.
        cells[cells.length - 1].text += segment;
        continue;
      }
      if (width > 0) {
        cells.push({ text: segment, width, style });
      }
    }
    index += chunk.length;
  }
  return cells;
}

function serializeCells(cells: Cell[]): string {
  let output = "";
  let active = "";
  for (const cell of cells) {
    if (cell.style !== active) {
      if (active) output += "\u001b[0m";
      output += cell.style;
      active = cell.style;
    }
    output += cell.text;
  }
  if (active) output += "\u001b[0m";
  return output;
}

// Wrap one logical line (which may carry SGR color codes) to rows of at most
// `width` cells. Breaks at the last space when one is available, and keeps a
// line's leading indentation on its continuation rows.
export function wrapStyledLine(text: string, width: number): string[] {
  const usable = Math.max(1, width);
  const cells = toCells(text);
  if (cells.length === 0) {
    return [""];
  }

  let leading = 0;
  while (leading < cells.length && cells[leading].text === " ") leading++;
  const indent = leading < usable / 2 ? leading : 0;
  const indentCells: Cell[] = Array.from({ length: indent }, () => ({
    text: " ",
    width: 1,
    style: ""
  }));

  const rows: string[] = [];
  let row: Cell[] = [];
  let rowWidth = 0;
  let lastSpace = -1;

  const startRow = (carry: Cell[]) => {
    row = [...indentCells];
    rowWidth = indent;
    lastSpace = -1;
    let skipping = true;
    for (const cell of carry) {
      if (skipping && cell.text === " ") continue;
      skipping = false;
      row.push(cell);
      rowWidth += cell.width;
    }
  };

  row = [];
  for (const original of cells) {
    const cell =
      original.width > usable ? { ...original, text: "�", width: 1 } : original;
    if (rowWidth + cell.width > usable && row.length > 0) {
      if (cell.text === " ") {
        rows.push(serializeCells(row));
        startRow([]);
        continue;
      }
      if (lastSpace > indent) {
        const carry = row.slice(lastSpace + 1);
        rows.push(serializeCells(row.slice(0, lastSpace)));
        startRow(carry);
      } else {
        rows.push(serializeCells(row));
        startRow([]);
      }
    }
    if (cell.text === " ") lastSpace = row.length;
    row.push(cell);
    rowWidth += cell.width;
  }
  rows.push(serializeCells(row));
  return rows;
}

export function truncateStyled(text: string, width: number): string {
  const cells = toCells(text);
  const kept: Cell[] = [];
  let used = 0;
  for (const cell of cells) {
    if (used + cell.width > width) break;
    kept.push(cell);
    used += cell.width;
  }
  return serializeCells(kept);
}

function dim(context: ChatFormatContext, text: string): string {
  return context.color ? `\u001b[2m${text}\u001b[0m` : text;
}

// ---------------------------------------------------------------------------
// Transcript: blocks, layout cache, scroll anchor, unread counter

export type ChatBlock =
  | { id: number; kind: "event"; event: RoomEvent }
  | { id: number; kind: "notice"; text: string };

type ChatAnchor =
  { follow: true } | { follow: false; block_id: number; offset: number };

interface Layout {
  rows: string[];
  starts: Map<number, number>;
  order: number[];
}

export class ChatTranscript {
  private blocks: ChatBlock[] = [];
  private nextId = 1;
  private anchor: ChatAnchor = { follow: true };
  private unreadCount = 0;
  private epoch = 0;
  private wrapCache = new Map<
    number,
    { key: string; lines: string[] | null }
  >();
  private layoutCache: { key: string; layout: Layout } | null = null;

  constructor(private readonly maxBlocks = MAX_TRANSCRIPT_BLOCKS) {}

  get following(): boolean {
    return this.anchor.follow;
  }

  get unread(): number {
    return this.unreadCount;
  }

  get size(): number {
    return this.blocks.length;
  }

  // Call when names, colors, or event visibility change so blocks re-render.
  invalidate(): void {
    this.epoch += 1;
    this.layoutCache = null;
  }

  appendEvent(event: RoomEvent): void {
    this.push({ id: this.nextId++, kind: "event", event });
    if (!this.anchor.follow && event.event_type === "message_sent") {
      this.unreadCount += 1;
    }
  }

  appendNotice(text: string): void {
    this.push({ id: this.nextId++, kind: "notice", text });
  }

  scrollBy(
    deltaRows: number,
    height: number,
    width: number,
    context: ChatFormatContext
  ): void {
    const layout = this.layout(width, context);
    const maxTop = Math.max(0, layout.rows.length - height);
    const top = Math.min(
      maxTop,
      Math.max(0, this.topRow(layout, maxTop) + deltaRows)
    );
    if (top >= maxTop) {
      this.scrollToBottom();
      return;
    }
    this.anchor = this.anchorForRow(layout, top);
  }

  scrollToBottom(): void {
    this.anchor = { follow: true };
    this.unreadCount = 0;
  }

  // The rows to show in a viewport of `height`, bottom-aligned so a short
  // conversation sits just above the input like a chat, not at the top.
  viewport(
    height: number,
    width: number,
    context: ChatFormatContext
  ): string[] {
    if (height <= 0) return [];
    const layout = this.layout(width, context);
    const maxTop = Math.max(0, layout.rows.length - height);
    const top = this.topRow(layout, maxTop);
    const visible = layout.rows.slice(top, top + height);
    while (visible.length < height) visible.unshift("");
    return visible;
  }

  private push(block: ChatBlock): void {
    this.blocks.push(block);
    this.layoutCache = null;
    while (this.blocks.length > this.maxBlocks) {
      const evicted = this.blocks.shift()!;
      this.wrapCache.delete(evicted.id);
      if (!this.anchor.follow && this.anchor.block_id === evicted.id) {
        this.anchor = { follow: false, block_id: this.blocks[0].id, offset: 0 };
      }
    }
  }

  private topRow(layout: Layout, maxTop: number): number {
    if (this.anchor.follow) return maxTop;
    const { block_id, offset } = this.anchor;
    let start = layout.starts.get(block_id);
    if (start === undefined) {
      // The anchored block is hidden now (e.g. /events toggled off); use the
      // next visible block after it.
      const next = layout.order.find((id) => id > block_id);
      start = next === undefined ? maxTop : layout.starts.get(next)!;
      return Math.min(maxTop, start);
    }
    return Math.min(maxTop, Math.max(0, start + offset));
  }

  private anchorForRow(layout: Layout, row: number): ChatAnchor {
    let chosen = layout.order[0];
    for (const id of layout.order) {
      if (layout.starts.get(id)! <= row) chosen = id;
      else break;
    }
    if (chosen === undefined) return { follow: true };
    return {
      follow: false,
      block_id: chosen,
      offset: row - layout.starts.get(chosen)!
    };
  }

  private layout(width: number, context: ChatFormatContext): Layout {
    const key = `${width}|${this.epoch}|${context.show_turn_events}|${context.color}`;
    if (this.layoutCache?.key === key) return this.layoutCache.layout;

    const rows: string[] = [];
    const starts = new Map<number, number>();
    const order: number[] = [];
    let previous: "message" | "other" | null = null;

    for (const block of this.blocks) {
      const lines = this.wrapBlock(block, width, context, key);
      if (lines === null) continue;
      const isMessage =
        block.kind === "event" && block.event.event_type === "message_sent";
      if (previous !== null && (isMessage || previous === "message")) {
        rows.push("");
      }
      starts.set(block.id, rows.length);
      order.push(block.id);
      rows.push(...lines);
      previous = isMessage ? "message" : "other";
    }

    const layout = { rows, starts, order };
    this.layoutCache = { key, layout };
    return layout;
  }

  private wrapBlock(
    block: ChatBlock,
    width: number,
    context: ChatFormatContext,
    key: string
  ): string[] | null {
    const cached = this.wrapCache.get(block.id);
    if (cached?.key === key) return cached.lines;
    const text =
      block.kind === "event"
        ? formatChatEvent(block.event, context)
        : block.text;
    const lines =
      text === null
        ? null
        : text.split("\n").flatMap((line) => wrapStyledLine(line, width));
    this.wrapCache.set(block.id, { key, lines });
    return lines;
  }
}

// ---------------------------------------------------------------------------
// Composer, command menu, completion

export interface ChatDraft {
  line: string;
  // UTF-16 offset into `line`, as reported by readline's `rl.cursor`.
  cursor: number;
}

export interface ComposerLayout {
  rows: string[];
  cursor_row: number;
  cursor_col: number;
}

export function layoutComposer(
  draft: ChatDraft,
  width: number,
  maxRows = MAX_COMPOSER_ROWS
): ComposerLayout {
  const usable = Math.max(CHAT_PROMPT.length + 2, width);
  const indent = " ".repeat(CHAT_PROMPT.length);
  const rows: string[] = [];
  let row = CHAT_PROMPT;
  let rowWidth = CHAT_PROMPT.length;
  let cursorRow = -1;
  let cursorCol = 0;
  let offset = 0;

  const newRow = () => {
    rows.push(row);
    row = indent;
    rowWidth = indent.length;
  };

  for (const { segment } of graphemes.segment(draft.line)) {
    const isBreak = segment === "\n" || segment === "\r\n";
    const cellWidth = isBreak ? 0 : graphemeWidth(segment);
    if (!isBreak && rowWidth + cellWidth > usable) {
      newRow();
    }
    if (cursorRow < 0 && offset >= draft.cursor) {
      cursorRow = rows.length;
      cursorCol = rowWidth;
    }
    if (isBreak) {
      newRow();
    } else {
      row += segment;
      rowWidth += cellWidth;
    }
    offset += segment.length;
  }

  if (cursorRow < 0) {
    // Cursor at the end: a full row pushes it onto a fresh row.
    if (rowWidth >= usable) {
      newRow();
    }
    cursorRow = rows.length;
    cursorCol = rowWidth;
  }
  rows.push(row);

  if (rows.length <= maxRows) {
    return { rows, cursor_row: cursorRow, cursor_col: cursorCol };
  }
  const first = Math.min(
    Math.max(0, cursorRow - maxRows + 1),
    rows.length - maxRows
  );
  return {
    rows: rows.slice(first, first + maxRows),
    cursor_row: cursorRow - first,
    cursor_col: cursorCol
  };
}

// Commands matching a draft that is still typing its command name.
export function matchChatCommands(line: string): ChatCommandInfo[] {
  const match = /^\/([a-z]*)$/i.exec(line);
  if (!match) return [];
  const prefix = match[1].toLowerCase();
  return CHAT_COMMANDS.filter((command) => command.name.startsWith(prefix));
}

// Tab completion for `/command` names and `@name` mentions. Returns null
// when there is nothing unambiguous to add.
export function completeChatInput(
  draft: ChatDraft,
  names: string[]
): ChatDraft | null {
  const before = draft.line.slice(0, draft.cursor);
  const after = draft.line.slice(draft.cursor);

  const command = /^\/([a-z]*)$/i.exec(before);
  if (command) {
    const matches = matchChatCommands(before);
    const completion = commonPrefix(matches.map((entry) => entry.name));
    if (!completion || completion.length < command[1].length) return null;
    const suffix = matches.length === 1 ? " " : "";
    const line = `/${completion}${suffix}${after}`;
    return { line, cursor: completion.length + 1 + suffix.length };
  }

  const mention = /(^|\s)@([^\s,]*)$/.exec(before);
  if (mention) {
    const typed = mention[2].toLowerCase();
    const matches = [...new Set(names)].filter((name) =>
      name.toLowerCase().startsWith(typed)
    );
    const completion = commonPrefix(matches);
    if (
      !completion ||
      (completion.length <= typed.length && matches.length !== 1)
    ) {
      return null;
    }
    const suffix = matches.length === 1 ? " " : "";
    const head = before.slice(0, before.length - mention[2].length);
    return {
      line: `${head}${completion}${suffix}${after}`,
      cursor: head.length + completion.length + suffix.length
    };
  }
  return null;
}

function commonPrefix(values: string[]): string {
  if (values.length === 0) return "";
  let prefix = values[0];
  for (const value of values.slice(1)) {
    let index = 0;
    while (
      index < prefix.length &&
      index < value.length &&
      prefix[index].toLowerCase() === value[index].toLowerCase()
    ) {
      index++;
    }
    prefix = prefix.slice(0, index);
  }
  return prefix;
}

// ---------------------------------------------------------------------------
// Frame rendering and diffing

export interface ChatScreenInput {
  transcript: ChatTranscript;
  format: ChatFormatContext;
  status: Omit<ChatStatusInput, "columns">;
  draft: ChatDraft;
  // A transient dim hint for the footer, e.g. "type /quit to exit".
  hint: string | null;
  columns: number;
  rows: number;
}

export interface ChatFrame {
  lines: string[];
  cursor: { row: number; col: number };
}

export function chatTranscriptHeight(
  input: Pick<ChatScreenInput, "columns" | "rows" | "draft">
): number {
  const width = Math.max(1, input.columns - 1);
  const height = Math.max(1, input.rows);
  if (width < 4 || height < 4) return 0;
  const composer = layoutComposer(
    input.draft,
    width,
    Math.min(MAX_COMPOSER_ROWS, height - 3)
  );
  const menu = Math.min(
    MAX_MENU_ROWS,
    matchChatCommands(input.draft.line).length
  );
  return Math.max(0, height - composer.rows.length - 3 - menu);
}

// Layout, top to bottom: transcript viewport, optional command menu, rule,
// composer, rule, status. Every row stays one cell short of the terminal
// width so the terminal never auto-wraps a full row.
export function renderChatScreen(input: ChatScreenInput): ChatFrame {
  const width = Math.max(1, input.columns - 1);
  const height = Math.max(1, input.rows);
  const context = input.format;

  if (width < 4 || height < 4) {
    return {
      lines: Array.from({ length: height }, (_, index) =>
        index === 0 ? truncateStyled("Resize terminal", width) : ""
      ),
      cursor: { row: 0, col: 0 }
    };
  }
  const composer = layoutComposer(
    input.draft,
    width,
    Math.min(MAX_COMPOSER_ROWS, height - 3)
  );
  const commands = matchChatCommands(input.draft.line);
  const menuRows = commands.slice(0, MAX_MENU_ROWS).map((command, index) => {
    const usage =
      index === 0 && context.color
        ? `\u001b[1m${command.usage}\u001b[0m`
        : command.usage;
    return truncateStyled(
      `  ${usage}  ${dim(context, command.description)}`,
      width
    );
  });

  const rule = dim(context, "─".repeat(width));
  const footer = renderFooter(input, width);

  const fixed = [rule, ...composer.rows, rule, footer];
  const transcriptHeight = chatTranscriptHeight(input);

  const transcript = input.transcript.viewport(
    transcriptHeight,
    width,
    context
  );
  const lines = [...transcript, ...menuRows, ...fixed]
    .slice(-height)
    .map((line) => truncateStyled(line, width));
  const composerTop = lines.length - composer.rows.length - 2;

  return {
    lines,
    cursor: {
      row: Math.min(height - 1, Math.max(0, composerTop + composer.cursor_row)),
      col: Math.min(width, composer.cursor_col)
    }
  };
}

function renderFooter(input: ChatScreenInput, width: number): string {
  const context = input.format;
  const transcript = input.transcript;
  let suffix = "";
  if (!transcript.following) {
    const label =
      transcript.unread > 0
        ? `↓ ${transcript.unread} new · ctrl+end`
        : "scrolled · ctrl+end";
    suffix = context.color ? `\u001b[1;33m${label}\u001b[0m` : label;
  } else if (input.hint) {
    suffix = dim(context, input.hint);
  } else if (input.draft.line.length === 0) {
    suffix = dim(context, "/ for commands");
  }

  const gap = suffix ? 2 : 0;
  const suffixWidth = textWidth(suffix);
  const statusWidth = Math.max(0, width - suffixWidth - gap);
  const status =
    statusWidth > 0
      ? formatChatStatus({ ...input.status, columns: statusWidth + 1 }, context)
      : "";
  const statusCells = textWidth(status);
  if (!suffix) {
    return truncateStyled(status, width);
  }
  const padding = Math.max(gap, width - statusCells - suffixWidth);
  return truncateStyled(`${status}${" ".repeat(padding)}${suffix}`, width);
}

// Terminal writes that turn `previous` into `next`: only changed rows are
// rewritten, inside a synchronized update so terminals that support it never
// show a half-drawn frame. Pass `previous = null` to repaint everything.
export function diffChatFrame(
  previous: ChatFrame | null,
  next: ChatFrame
): string {
  let output = "\u001b[?2026h";
  if (previous === null || previous.lines.length !== next.lines.length) {
    output += "\u001b[H\u001b[2J";
    previous = null;
  }
  next.lines.forEach((line, index) => {
    if (previous?.lines[index] !== line) {
      output += `\u001b[${index + 1};1H\u001b[2K${line}`;
    }
  });
  output += `\u001b[${next.cursor.row + 1};${next.cursor.col + 1}H\u001b[?2026l`;
  return output;
}
