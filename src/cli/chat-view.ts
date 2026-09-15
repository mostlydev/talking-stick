import stringWidth from "string-width";
import type { RoomEvent } from "../types.js";
import {
  formatChatEvent,
  chatSectionLabel,
  startsChatConversation,
  isChatConversationActivity,
  formatChatStatus,
  sanitizeChatText,
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
  { name: "kick", usage: "/kick <agent>", description: "remove a member; --force for a live agent" },
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

// Help is intentionally compact; detailed keyboard controls have their own
// view so the command list remains readable at ordinary terminal heights.
export function formatChatHelp(width: number, color: boolean, keys = false): string {
  const usable = Math.max(12, width);
  const accent = (text: string) => color ? `\u001b[1;38;5;147m${text}\u001b[0m` : text;
  const muted = (text: string) => color ? `\u001b[2m${text}\u001b[0m` : text;
  const entries: [string, string][] = keys ? [
    ["Enter", "Send; accept an incomplete suggestion first"],
    ["Tab", "Accept the selected suggestion"],
    ["↑ / ↓", "Choose a suggestion, or move through draft lines"],
    ["Alt+Enter", "Insert a new line"],
    ["Esc", "Dismiss suggestions; press again to clear"],
    ["Ctrl+C", "Clear the draft"],
    ["PgUp / PgDn", "Scroll the conversation"],
    ["Shift+↑ / ↓ · wheel", "Scroll a few lines"],
    ["Ctrl+End", "Return to the latest messages"],
    ["Ctrl+D", "Quit when the draft is empty"]
  ] : CHAT_COMMANDS.map((command) => [
    command.name === "help" ? "/help keys" : command.usage,
    command.name === "help" ? "Keyboard shortcuts" : command.description
  ]);
  const labelWidth = Math.max(...entries.map(([label]) => textWidth(label)));
  const wide = usable >= labelWidth + 28;
  const lines = ["", accent(keys ? "Keyboard shortcuts" : "Chat commands"), ""];
  for (const [index, [label, description]] of entries.entries()) {
    if (index > 0 && !keys) lines.push("");
    if (wide) {
      const indent = " ".repeat(labelWidth + 4);
      const descriptions = wrapStyledLine(muted(description), usable - indent.length);
      lines.push(`  ${accent(label)}${" ".repeat(labelWidth - textWidth(label) + 2)}${descriptions[0]}`);
      lines.push(...descriptions.slice(1).map((line) => indent + line));
    } else {
      lines.push(...wrapStyledLine(`  ${accent(label)}`, usable));
      lines.push(...wrapStyledLine(`    ${muted(description)}`, usable));
    }
  }
  lines.push("");
  for (const note of keys ? [
    "Single-line drafts use ↑ / ↓ for history when suggestions are closed.",
    "Paste stays in the draft until sent. Shift+Enter also works in supported terminals.",
    "/help returns to commands."
  ] : [
    "Type to message the room. Use @agent to address a participant.",
    "!@agent sends an urgent message; @everyone reaches all agents.",
    "Use // to send text beginning with a slash."
  ]) lines.push(...wrapStyledLine(muted(note), usable));
  return lines.join("\n");
}

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

  appendNotice(text: string): number {
    const id = this.nextId++;
    this.push({ id, kind: "notice", text });
    return id;
  }

  // Rewrites a notice in place (e.g. a delivery status that later advances).
  // Returns false once the notice has been evicted.
  updateNotice(id: number, text: string): boolean {
    const block = this.blocks.find((candidate) => candidate.id === id);
    if (!block || block.kind !== "notice") return false;
    block.text = text;
    this.wrapCache.delete(id);
    this.layoutCache = null;
    return true;
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
    const key = `${width}|${this.epoch}|${context.show_turn_events}|${context.color}|${context.now?.toDateString()}|${context.history_before}`;
    if (this.layoutCache?.key === key) return this.layoutCache.layout;

    const rows: string[] = [];
    const starts = new Map<number, number>();
    const order: number[] = [];
    let previous: "message" | "other" | null = null;
    let previousEvent: RoomEvent | undefined;
    let section: string | undefined;

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
      if (block.kind === "event" && context.now) {
        const label = chatSectionLabel(block.event, context);
        const newConversation = startsChatConversation(previousEvent, block.event);
        if (label !== section || newConversation) {
          rows.push(...wrapStyledLine(dim(context, `── ${newConversation ? "New conversation · " : ""}${label} ──`), width));
          section = label;
        }
        if (isChatConversationActivity(block.event)) previousEvent = block.event;
      }
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

interface ComposerStop { offset: number; row: number; col: number }

function composerGeometry(draft: ChatDraft, width: number): ComposerLayout & { stops: ComposerStop[] } {
  const usable = Math.max(CHAT_PROMPT.length + 2, width);
  const indent = " ".repeat(CHAT_PROMPT.length);
  const rows: string[] = [];
  const stops: ComposerStop[] = [];
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
    stops.push({ offset, row: rows.length, col: rowWidth });
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

  if (rowWidth >= usable) newRow();
  stops.push({ offset, row: rows.length, col: rowWidth });
  if (cursorRow < 0) {
    cursorRow = rows.length;
    cursorCol = rowWidth;
  }
  rows.push(row);
  return { rows, cursor_row: cursorRow, cursor_col: cursorCol, stops };
}

export function moveChatCursorVertical(draft: ChatDraft, width: number, direction: number, preferredColumn?: number): { draft: ChatDraft; column: number } | null {
  const geometry = composerGeometry(draft, width);
  if (geometry.rows.length === 1) return null;
  const column = preferredColumn ?? geometry.cursor_col;
  const target = geometry.cursor_row + direction;
  const stops = geometry.stops.filter((stop) => stop.row === target);
  const closest = stops.reduce<ComposerStop | undefined>((best, stop) =>
    !best || Math.abs(stop.col - column) < Math.abs(best.col - column) ? stop : best, undefined);
  return { draft: { line: draft.line, cursor: closest?.offset ?? draft.cursor }, column };
}

export function layoutComposer(draft: ChatDraft, width: number, maxRows = MAX_COMPOSER_ROWS): ComposerLayout {
  const { rows, cursor_row: cursorRow, cursor_col: cursorCol } = composerGeometry(draft, width);
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

export interface ChatCompletion {
  label: string;
  description: string;
  draft: ChatDraft;
}

export interface ChatMemberCompletion {
  agent_id: string;
  name: string;
  status: string;
}

export function getChatCompletions(draft: ChatDraft, names: string[], kickMembers: ChatMemberCompletion[] = []): ChatCompletion[] {
  const before = draft.line.slice(0, draft.cursor);
  const after = draft.line.slice(draft.cursor);
  const command = /^\/([a-z]*)$/i.exec(before);
  if (command) {
    const tail = after.replace(/^[a-z]*/i, "");
    return matchChatCommands(before).map((entry) => {
      const text = `/${entry.name}${/^\s/.test(tail) ? "" : " "}`;
      return { label: entry.usage, description: entry.description, draft: { line: text + tail, cursor: text.length } };
    });
  }
  const kick = /^(\/kick\s+(?:--force\s+)?@?)([^\s]*)$/i.exec(before);
  if (kick) {
    const typed = kick[2].toLowerCase();
    const tail = after.replace(/^\S*/, "");
    return kickMembers.filter((member) => member.agent_id.toLowerCase().startsWith(typed) ||
      member.name.toLowerCase().startsWith(typed)).map((member) => {
      const text = `${kick[1]}${member.agent_id}${/^\s/.test(tail) ? "" : " "}`;
      return { label: sanitizeChatText(member.agent_id), description: sanitizeChatText(`${member.status}${member.name !== member.agent_id ? ` · ${member.name}` : ""}`).replace(/\n/g, " "),
        draft: { line: text + tail, cursor: text.length } };
    });
  }
  // Match the same punctuation boundaries as mentions, without completing
  // email addresses or text inside backtick code spans.
  if ((before.match(/`/g)?.length ?? 0) % 2 !== 0) return [];
  const mention = /(^|[^\p{L}\p{N}_@])(!?@)([\p{L}\p{N}_:.-]*)$/u.exec(before);
  if (!mention) return [];
  const typed = mention[3].toLowerCase();
  const head = before.slice(0, before.length - mention[3].length);
  const remainder = (/^[\p{L}\p{N}_:.-]*/u.exec(after)?.[0] ?? "").replace(/[.:-]+$/, "");
  const tail = after.slice(remainder.length);
  return [...new Set([...names, "everyone"])].filter((name) =>
    /^[\p{L}\p{N}_:.-]+$/u.test(name) && name.toLowerCase().startsWith(typed) &&
    // Prefer a short unique name; offer full ids when their colon is typed.
    (typed.includes(":") || !name.includes(":") || !names.includes(name.split(":")[0]))
  ).map((name) => {
    const text = `${head}${name}${/^[\s,.;:!?)-]/.test(tail) ? "" : " "}`;
    return { label: `${mention[2]}${name}`, description: name === "everyone" ? "all available agents" : "message agent", draft: { line: text + tail, cursor: text.length } };
  });
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
  room_path?: string;
  transcript: ChatTranscript;
  format: ChatFormatContext;
  status: Omit<ChatStatusInput, "columns">;
  draft: ChatDraft;
  // A transient dim hint for the footer, e.g. "type /quit to exit".
  hint: string | null;
  completions?: ChatCompletion[];
  completion_index?: number;
  columns: number;
  rows: number;
}

export interface ChatFrame {
  lines: string[];
  cursor: { row: number; col: number };
}

// The suggestion menu overlays the bottom of the transcript instead of
// shrinking it, so the conversation never shifts while the operator types.
export function chatTranscriptHeight(
  input: Pick<ChatScreenInput, "columns" | "rows" | "draft" | "room_path">
): number {
  const width = Math.max(1, input.columns - 1);
  const height = Math.max(1, input.rows);
  if (width < 4 || height < 4) return 0;
  const composer = layoutComposer(
    input.draft,
    width,
    Math.min(MAX_COMPOSER_ROWS, height - 3 - roomHeaderRows(input))
  );
  return Math.max(0, height - composer.rows.length - 3 - roomHeaderRows(input));
}

function roomHeaderRows(input: Pick<ChatScreenInput, "rows" | "room_path">): number {
  return input.room_path && input.rows >= 6 ? 1 : 0;
}

function roomHeader(path: string, width: number, context: ChatFormatContext): string {
  const safe = sanitizeChatText(path).replace(/\s+/g, " ");
  const prefix = width >= 16 ? "Room · " : "";
  const budget = width - textWidth(prefix);
  const parts = Array.from(safe);
  let shortened = false;
  while (parts.length && textWidth(parts.join("")) + (shortened ? 1 : 0) > budget) {
    parts.shift();
    shortened = true;
  }
  return dim(context, prefix + (shortened ? "…" : "") + parts.join(""));
}

// Layout, top to bottom: transcript viewport (with the suggestion menu drawn
// over its last rows), rule, composer, rule, status. Every row stays one cell short of the terminal
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
    Math.min(MAX_COMPOSER_ROWS, height - 3 - roomHeaderRows(input))
  );
  const transcriptHeight = chatTranscriptHeight(input);
  const menuCapacity = Math.min(MAX_MENU_ROWS, Math.max(0, transcriptHeight - (transcriptHeight > 1 ? 1 : 0)));
  const completions = input.completions ?? getChatCompletions(input.draft, []);
  const selected = Math.max(0, Math.min(input.completion_index ?? 0, completions.length - 1));
  const first = Math.max(0, selected - menuCapacity + 1);
  const menuRows = completions.slice(first, first + menuCapacity).map((entry, index) => {
    const active = first + index === selected;
    const label = active && context.color ? `\u001b[1m${entry.label}\u001b[0m` : entry.label;
    return truncateStyled(`${active ? "›" : " "} ${label}  ${dim(context, entry.description)}`, width);
  });

  const rule = dim(context, "─".repeat(width));
  const footer = renderFooter(input, width);

  const fixed = [rule, ...composer.rows, rule, footer];

  const transcript = input.transcript.viewport(
    transcriptHeight,
    width,
    context
  );
  // Occlude the transcript's bottom rows with a blank separator and the menu;
  // keep the selection visible even if only one menu row fits.
  if (menuRows.length > 0 && transcript.length > 0) {
    const overlay = [...(transcriptHeight > 1 ? [""] : []), ...menuRows];
    transcript.splice(transcript.length - overlay.length, overlay.length, ...overlay);
  }
  const header = roomHeaderRows(input) ? [roomHeader(input.room_path!, width, context)] : [];
  const lines = [...header, ...transcript, ...fixed]
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
  } else if ((input.completions?.length ?? 0) > 0) {
    suffix = dim(context, "↑↓ choose · Tab accept · Esc dismiss");
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
