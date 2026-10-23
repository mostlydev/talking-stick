import { isHumanAttentionMessage } from "../human-attention.js";
import { renderAttention, resolveAttentionFrame, type HumanAttention, type AttentionHit } from "./chat-attention.js";
import stringWidth from "string-width";
import { draftStyleSpans, type DraftHighlightOptions } from "./chat-draft-highlight.js";
import { agentStyle, paintStyle, themeStyle, type ChatColorMode } from "./theme.js";
import type { RoomEvent } from "../types.js";
import {
  formatChatEvent,
  chatSectionLabel,
  startsChatConversation,
  isChatConversationActivity,
  formatChatStatus,
  sanitizeChatText,
  resolveChatRecipient,
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
  { name: "members", usage: "/members", description: "choose a member to message or remove (right-click status with --fullscreen --mouse)" },
  { name: "who", usage: "/who", description: "members and who has the stick" },
  { name: "roles", usage: "/roles", description: "edit assignments and harness defaults (Tab switches scope; Enter applies)" },
  { name: "rooms", usage: "/rooms [room]", description: "browse host rooms or folders; / filter, Tab views (Ctrl+T)" },
  { name: "go", usage: "/go <room|dir>", description: "choose an open room with ↑↓ Enter; a directory opens its room" },
  { name: "attach", usage: "/attach <file>", description: "add an image to the draft (Ctrl+V pastes the clipboard's image)" },
  { name: "older", usage: "/older", description: "load an earlier page of saved messages" },
  { name: "clear", usage: "/clear", description: "clear this room view and remember where to resume" },
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
  { name: "unread", usage: "/unread", description: "visit the next missed message; Escape returns live" },
  { name: "ack", usage: "/ack [#message|all]", description: "acknowledge visible messages (or one message/all pending)" },
  { name: "theme", usage: "/theme [lantern|tide|dusk]", description: "show or change the chat palette" },
  { name: "help", usage: "/help", description: "list commands and keys" }
];

// Help is intentionally compact; detailed keyboard controls have their own
// view so the command list remains readable at ordinary terminal heights.
export function formatChatHelp(width: number, color: boolean, keys = false, inline = false, mode: ChatColorMode = "256"): string {
  const usable = Math.max(12, width);
  const accent = (text: string) => paintStyle(color, `1;${themeStyle("accent", mode)}`, text);
  const muted = (text: string) => color ? `\u001b[2m${text}\u001b[0m` : text;
  const entries: [string, string][] = keys ? [
    ["Enter", "Send; in /go, open the selected room"],
    ["Tab", "Accept the selected suggestion"],
    ["↑ / ↓", "Recall prompts; choose suggestions or edit draft lines"],
    ["Ctrl+P / Ctrl+N", "Recall previous / next submitted prompt"],
    ["Shift+Enter", "Insert a new line (Alt+Enter also works)"],
    ["Ctrl+V", "Attach the clipboard's image as [Image #N]; delete the marker to drop it"],
    ["Esc", "Clear text; interrupt agents when the draft is empty"],
    ["Ctrl+C", "Clear the draft"],
    ["Ctrl+T", "Browse folders and rooms"],
    ["Alt+← / Alt+→", "Previous / next open room in this repository"],
    ["Ctrl+PgUp / PgDn", "Room-switch fallback if the terminal captures Alt+Arrow"],
    ...(inline ? [
      ["Wheel / terminal scroll", "Browse messages; drag to select and copy"],
      ["/older", "Print an earlier page of saved messages"]
    ] as [string, string][] : [
      ["PgUp / PgDn", "Scroll the conversation"],
      ["Shift+↑ / ↓", "Scroll a few lines (wheel with --mouse)"],
      ["Ctrl+End", "Return to the latest messages"]
    ] as [string, string][]),
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
    "Paste stays in the draft until sent. Shift+Enter needs a terminal with enhanced keys; Alt+Enter works anywhere.",
    "/help returns to commands."
  ] : [
    "Type to message every agent in the room. @agent narrows it to that agent.",
    "!@agent sends an urgent message; !@everyone makes a room message urgent.",
    "Marks after names in your messages: … not delivered yet, ✓ delivered, ! failed.",
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
  link?: string;
  offset?: number;
}

function toCells(text: string): Cell[] {
  const cells: Cell[] = [];
  let style = "";
  let link = "";
  let plainOffset = 0;
  let index = 0;
  while (index < text.length) {
    const osc = /^\u001b\]8;[^;]*;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/.exec(text.slice(index));
    if (osc) { link = osc[1]; index += osc[0].length; continue; }
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
      const offset = plainOffset;
      plainOffset += segment.length;
      if (width === 0 && cells.length > 0 && segment.codePointAt(0)! >= 0x20) {
        // Attach combining marks to the preceding cell.
        cells[cells.length - 1].text += segment;
        continue;
      }
      if (width > 0) {
        cells.push({ text: segment, width, style, link, offset });
      }
    }
    index += chunk.length;
  }
  return cells;
}

function serializeCells(cells: Cell[]): string {
  let output = "";
  let active = "";
  let activeLink = "";
  for (const cell of cells) {
    const link = cell.link ?? "";
    if (link !== activeLink) {
      output += `\u001b]8;;${link}\u001b\\`;
      activeLink = link;
    }
    if (cell.style !== active) {
      if (active) output += "\u001b[0m";
      output += cell.style;
      active = cell.style;
    }
    output += cell.text;
  }
  if (active) output += "\u001b[0m";
  if (activeLink) output += "\u001b]8;;\u001b\\";
  return output;
}

// Wrap one logical line (which may carry SGR color codes) to rows of at most
// `width` cells. Breaks at the last space when one is available, and keeps a
// line's leading indentation on its continuation rows.
function wrapStyledCells(text: string, width: number): Cell[][] {
  const usable = Math.max(1, width);
  const cells = toCells(text);
  if (cells.length === 0) {
    return [[]];
  }

  let leading = 0;
  while (leading < cells.length && cells[leading].text === " ") leading++;
  const indent = leading < usable / 2 ? leading : 0;
  const indentCells: Cell[] = Array.from({ length: indent }, () => ({
    text: " ",
    width: 1,
    style: ""
  }));

  const rows: Cell[][] = [];
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
        rows.push([...row]);
        startRow([]);
        continue;
      }
      if (lastSpace > indent) {
        const carry = row.slice(lastSpace + 1);
        rows.push(row.slice(0, lastSpace));
        startRow(carry);
      } else {
        rows.push([...row]);
        startRow([]);
      }
    }
    if (cell.text === " ") lastSpace = row.length;
    row.push(cell);
    rowWidth += cell.width;
  }
  rows.push([...row]);
  return rows;
}

export interface StyledRow { text: string; start: number; end: number; indent: number }

export function wrapStyledRows(text: string, width: number): StyledRow[] {
  return wrapStyledCells(text, width).map(cells => {
    const source = cells.filter(cell => cell.offset !== undefined);
    return { text: serializeCells(cells), start: source[0]?.offset ?? 0,
      end: source.length ? source.at(-1)!.offset! + source.at(-1)!.text.length : 0,
      indent: cells.findIndex(cell => cell.offset !== undefined) };
  });
}

export function wrapStyledLine(text: string, width: number): string[] {
  return wrapStyledRows(text, width).map(row => row.text);
}

export function skipStyledText(text: string, count: number): string {
  return serializeCells(toCells(text).filter(cell => (cell.offset ?? 0) >= count));
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

export interface TranscriptRow extends StyledRow { block_id: number; line: number }

interface Layout {
  history_rows: TranscriptRow[];
  rows: string[];
  starts: Map<number, number>;
  order: number[];
  receipts: Map<number, number>;
  human_messages: AttentionHit[];
}

export class ChatTranscript {
  private traversedHumanMessages = new Set<number>();
  private outputBuffered = false;
  private blocks: ChatBlock[] = [];
  private nextId = 1;
  private earlierId = 0;
  private anchor: ChatAnchor = { follow: true };
  private unreadCount = 0;
  private epoch = 0;
  private wrapCache = new Map<
    number,
    { key: string; lines: string[] | null; anchors: Array<StyledRow & { line: number }> }
  >();
  private layoutCache: { key: string; layout: Layout } | null = null;

  constructor(private readonly maxBlocks = MAX_TRANSCRIPT_BLOCKS) {}

  clear(): void {
    this.blocks = [];
    this.wrapCache.clear();
    this.layoutCache = null;
    this.anchor = { follow: true };
    this.unreadCount = 0;
    this.outputBuffered = false;
    this.traversedHumanMessages.clear();
  }

  setOutputBuffered(buffered: boolean): void {
    this.outputBuffered = buffered;
    if (!buffered && this.anchor.follow) this.trimLiveBuffer();
  }

  markHumanMessagesTraversed(seqs: Iterable<number>): void {
    for (const seq of seqs) this.traversedHumanMessages.add(seq);
  }

  wasManuallyTraversed(seq: number): boolean {
    return this.traversedHumanMessages.has(seq);
  }

  // The event a content row belongs to; headings and separators have none.
  eventSeqForRow(row: TranscriptRow): number | null {
    if (row.line < 0) return null;
    const block = this.blocks.find(candidate => candidate.id === row.block_id);
    return block?.kind === "event" ? block.event.event_seq : null;
  }

  get following(): boolean {
    return this.anchor.follow;
  }

  get unread(): number {
    return this.unreadCount;
  }

  get size(): number {
    return this.blocks.length;
  }

  get oldestEventSeq(): number | undefined {
    const block = this.blocks.find((candidate) => candidate.kind === "event");
    return block?.kind === "event" ? block.event.event_seq : undefined;
  }

  needsEarlier(deltaRows: number, height: number, width: number, context: ChatFormatContext): boolean {
    const layout = this.layout(width, context);
    return deltaRows < 0 && this.topRow(layout, Math.max(0, layout.rows.length - height)) + deltaRows <= 0;
  }

  prependEvents(events: RoomEvent[], height: number, width: number, context: ChatFormatContext): void {
    if (events.length === 0) return;
    const layout = this.layout(width, context);
    this.anchor = this.anchorForRow(layout, this.topRow(layout, Math.max(0, layout.rows.length - height)));
    const start = this.earlierId - events.length + 1;
    this.blocks.unshift(...events.map((event, index): ChatBlock => ({ id: start + index, kind: "event", event })));
    this.earlierId -= events.length;
    this.layoutCache = null;
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
    const previousTop = this.topRow(layout, maxTop);
    const top = Math.min(
      maxTop,
      Math.max(0, this.topRow(layout, maxTop) + deltaRows)
    );
    if (top !== previousTop) {
      const start = Math.min(top, previousTop);
      const end = Math.max(top, previousTop) + height;
      this.markHumanMessagesTraversed(layout.human_messages
        .filter(hit => hit.row >= start && hit.row < end).map(hit => hit.event_seq));
    }
    if (top >= maxTop) {
      this.scrollToBottom();
      return;
    }
    this.anchor = this.anchorForRow(layout, top);
  }

  scrollToBottom(): void {
    this.anchor = { follow: true };
    this.unreadCount = 0;
    this.trimLiveBuffer();
  }

  /** Anchor the original timeline at an event without marking intervening rows read. */
  scrollToEvent(seq: number, height: number, width: number, context: ChatFormatContext): boolean {
    const layout = this.layout(width, context);
    const block = this.blocks.find(candidate => candidate.kind === "event" && candidate.event.event_seq === seq);
    const row = block && layout.starts.get(block.id);
    if (row === undefined) return false;
    // The header lands at the top: partial context above it reads as an orphaned line.
    this.anchor = this.anchorForRow(layout, Math.min(row, Math.max(0, layout.rows.length - height)));
    return true;
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
    if (this.anchor.follow) this.trimLiveBuffer();
  }

  private trimLiveBuffer(): void {
    if (this.outputBuffered) return;
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

  historyRows(width: number, context: ChatFormatContext): TranscriptRow[] {
    return this.layout(width, context).history_rows;
  }

  // Physical row anchors for message receipts in the same viewport geometry.
  receiptRows(height: number, width: number, context: ChatFormatContext): Map<number, number> {
    const layout = this.layout(width, context);
    const top = this.topRow(layout, Math.max(0, layout.rows.length - height));
    const padding = Math.max(0, height - Math.min(height, layout.rows.length - top));
    return new Map([...layout.receipts].filter(([, row]) => row >= top && row < top + height)
      .map(([seq, row]) => [seq, padding + row - top]));
  }

  humanMessageRows(height: number, width: number, context: ChatFormatContext): AttentionHit[] {
    const layout = this.layout(width, context);
    const top = this.topRow(layout, Math.max(0, layout.rows.length - height));
    const padding = Math.max(0, height - Math.min(height, layout.rows.length - top));
    return layout.human_messages.filter(hit => hit.row >= top && hit.row < top + height)
      .map(hit => ({ ...hit, row: padding + hit.row - top }));
  }

  private layout(width: number, context: ChatFormatContext): Layout {
    const wrapKey = `${width}|${this.epoch}|${context.show_turn_events}|${context.color}|${context.now?.toDateString()}|${context.history_before}|${context.focused_event ?? ""}`;
    const key = wrapKey + "|" + [...(context.excluded_events ?? [])].join(",");
    if (this.layoutCache?.key === key) return this.layoutCache.layout;

    const rows: string[] = [];
    const historyRows: TranscriptRow[] = [];
    const starts = new Map<number, number>();
    const order: number[] = [];
    const receipts = new Map<number, number>();
    const humanMessages: AttentionHit[] = [];
    let previous: "message" | "other" | null = null;
    let previousEvent: RoomEvent | undefined;
    let section: string | undefined;

    for (const block of this.blocks) {
      if (block.kind === "event" && context.excluded_events?.has(block.event.event_seq)) continue;
      const lines = this.wrapBlock(block, width, context, wrapKey);
      if (lines === null) continue;
      const isMessage =
        block.kind === "event" && block.event.event_type === "message_sent";
      if (previous !== null && (isMessage || previous === "message")) {
        rows.push("");
        historyRows.push({ text: "", block_id: block.id, line: -2, start: 0, end: 0, indent: 0 });
      }
      starts.set(block.id, rows.length);
      order.push(block.id);
      if (block.kind === "event" && context.now) {
        const label = chatSectionLabel(block.event, context);
        const newConversation = startsChatConversation(previousEvent, block.event);
        if (label !== section || newConversation) {
          const headings = wrapStyledRows(dim(context, `── ${newConversation ? "New conversation · " : ""}${label} ──`), width);
          rows.push(...headings.map(row => row.text));
          historyRows.push(...headings.map(row => ({ ...row, block_id: block.id, line: -1 })));
          section = label;
        }
        if (isChatConversationActivity(block.event)) previousEvent = block.event;
      }
      if (block.kind === "event" && context.tracks_delivery?.(block.event)) {
        receipts.set(block.event.event_seq, rows.length);
      }
      if (block.kind === "event" && isHumanAttentionMessage(block.event, context.self_agent_id) &&
          !context.human_acknowledged?.(block.event)) {
        for (let offset = 0; offset < lines.length; offset++) {
          humanMessages.push({ event_seq: block.event.event_seq, row: rows.length + offset });
        }
      }
      rows.push(...lines);
      historyRows.push(...this.wrapCache.get(block.id)!.anchors.map(row => ({ ...row, block_id: block.id })));
      previous = isMessage ? "message" : "other";
    }

    const layout = { history_rows: historyRows, rows, starts, order, receipts, human_messages: humanMessages };
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
    const anchors = text === null ? [] : text.split("\n").flatMap((text, line) =>
      wrapStyledRows(text, width).map(row => ({ ...row, line })));
    const lines = text === null ? null : anchors.map(row => row.text);
    this.wrapCache.set(block.id, { key, lines, anchors });
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

function composerGeometry(draft: ChatDraft, width: number, highlight?: DraftHighlightOptions): ComposerLayout & { stops: ComposerStop[] } {
  const usable = Math.max(CHAT_PROMPT.length + 2, width);
  const indent = " ".repeat(CHAT_PROMPT.length);
  const rows: string[] = [];
  const stops: ComposerStop[] = [];
  const spans = highlight ? draftStyleSpans(draft.line, highlight) : [];
  let row = highlight ? paintStyle(true, `1;${themeStyle("accent", highlight.color_mode)}`, CHAT_PROMPT) : CHAT_PROMPT;
  let activeStyle = "";
  let rowWidth = CHAT_PROMPT.length;
  let cursorRow = -1;
  let cursorCol = 0;
  let offset = 0;

  const newRow = () => {
    if (activeStyle) row += "\u001b[0m";
    rows.push(row);
    row = indent;
    rowWidth = indent.length;
    activeStyle = "";
  };

  const segments = [...graphemes.segment(draft.line)].map(({ segment }) => segment);
  const isBreakSegment = (segment: string) => segment === "\n" || segment === "\r\n";
  const isSpace = (segment: string) => segment === " " || segment === "\t";
  for (const [index, segment] of segments.entries()) {
    const isBreak = isBreakSegment(segment);
    const cellWidth = isBreak ? 0 : graphemeWidth(segment);
    // Word wrap: a word that would cross the edge moves whole to the next row
    // when it fits there; a word wider than a row still breaks by character.
    if (!isBreak && !isSpace(segment) && index > 0 && isSpace(segments[index - 1]) && rowWidth > indent.length) {
      let wordWidth = 0;
      for (let next = index; next < segments.length && !isSpace(segments[next]) && !isBreakSegment(segments[next]); next++) {
        wordWidth += graphemeWidth(segments[next]);
      }
      if (rowWidth + wordWidth > usable && indent.length + wordWidth <= usable) newRow();
    }
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
      const style = spans.find(span => offset >= span.start && offset < span.end)?.style ?? "";
      if (style !== activeStyle) {
        if (activeStyle) row += "\u001b[0m";
        if (style) row += `\u001b[${style}m`;
        activeStyle = style;
      }
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
  if (activeStyle) row += "\u001b[0m";
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

export function layoutComposer(draft: ChatDraft, width: number, maxRows = MAX_COMPOSER_ROWS, highlight?: DraftHighlightOptions): ComposerLayout {
  const { rows, cursor_row: cursorRow, cursor_col: cursorCol } = composerGeometry(draft, width, highlight);
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

export interface ChatRoomCompletion {
  /** What `/go` accepts: a unique short name or path suffix, or `root`. */
  name: string;
  description: string;
}

export function getChatCompletions(draft: ChatDraft, names: string[], kickMembers: ChatMemberCompletion[] = [],
  rooms: ChatRoomCompletion[] = []): ChatCompletion[] {
  const before = draft.line.slice(0, draft.cursor);
  const after = draft.line.slice(draft.cursor);
  const go = /^(\/go)(?:\s+#?([^\s]*))?$/i.exec(before);
  if (go) {
    const typed = (go[2] ?? "").toLowerCase();
    const tail = after.replace(/^\S*/, "");
    const matched = rooms.filter((room) => room.name.toLowerCase().startsWith(typed) ||
      room.name.toLowerCase().split("/").some((part) => part.startsWith(typed)));
    if (typed) matched.sort((left, right) => Number(right.name.toLowerCase() === typed) - Number(left.name.toLowerCase() === typed));
    return matched.map((room) => {
      const text = `/go ${room.name}${/^\s/.test(tail) ? "" : " "}`;
      return { label: `#${sanitizeChatText(room.name)}`, description: sanitizeChatText(room.description).replace(/\n/g, " "),
        draft: { line: text + tail, cursor: text.length } };
    });
  }
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
  /** Other rooms in this repository, e.g. "#api 2● · #web", already painted. */
  room_strip?: string;
  /**
   * A modal panel (e.g. the /roles editor), already painted. It takes the
   * place of the suggestion menu above the room bar.
   */
  panel?: string[];
  attention?: HumanAttention;
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

function draftHighlight(input: ChatScreenInput): DraftHighlightOptions | undefined {
  if (!input.format.color) return undefined;
  const members = input.status.members.filter(member => member.agent_id !== input.format.self_agent_id && member.process_liveness !== "gone");
  const aliases = members.flatMap(member => [member.agent_id, member.display_name ?? "", input.format.name_of(member.agent_id), member.agent_id.split(":")[0]]
    .filter(Boolean).map(name => ({ name: name.toLowerCase(), id: member.agent_id })));
  return {
    commands: [...CHAT_COMMANDS.map(command => command.name), "exit", "q", "dm", "msg", "all", "room", "int"],
    color_mode: input.format.color_mode,
    mention: selector => {
      if (selector === "everyone" || selector === "all") return { state: "group" };
      const exact = aliases.find(alias => alias.name === selector);
      if (exact) {
        const recipients = resolveChatRecipient(selector, members, input.format.self_agent_id);
        if ("error" in recipients) return { state: "unknown" };
        return recipients.agent_ids.length === 1
          ? { state: "resolved", id: recipients.agent_ids[0] } : { state: "group" };
      }
      return { state: aliases.some(alias => alias.name.startsWith(selector)) || !selector ? "partial" : "unknown" };
    }
  };
}

function completionRow(input: ChatScreenInput, entry: ChatCompletion, active: boolean, width: number, highlight: DraftHighlightOptions | undefined): string {
  if (!input.format.color) return truncateStyled(`${active ? "›" : " "} ${entry.label}  ${entry.description}`, width);
  const mode = input.format.color_mode;
  const selector = entry.label.replace(/^!?@/, "");
  const resolution = highlight!.mention(selector.toLowerCase());
  const labelStyle = entry.label.startsWith("/") ? themeStyle("command", mode)
    : entry.label.startsWith("#") ? themeStyle("path", mode)
    : resolution.id ? agentStyle(resolution.id, mode) : themeStyle("mention", mode);
  const typed = /\S*$/.exec(input.draft.line.slice(0, input.draft.cursor))?.[0] ?? "";
  const prefix = entry.label.startsWith("#") ? `#${typed.replace(/^#/, "")}` : typed;
  const matchLength = prefix && entry.label.toLowerCase().startsWith(prefix.toLowerCase()) ? prefix.length : 0;
  const label = paintStyle(true, `1;${labelStyle}`, entry.label.slice(0, matchLength)) +
    paintStyle(true, labelStyle, entry.label.slice(matchLength));
  const marker = paintStyle(true, `1;${themeStyle("accent", mode)}`, active ? "›" : " ");
  let row = truncateStyled(`${marker} ${label}  ${paintStyle(true, themeStyle("muted", mode), entry.description)}`, width);
  if (active) {
    const selection = `\u001b[${themeStyle("selection", mode, true)};${themeStyle("selectionText", mode)}m`;
    row = selection + row.replace(/\u001b\[0m/g, `\u001b[0m${selection}`) + " ".repeat(Math.max(0, width - textWidth(row))) + "\u001b[0m";
  }
  return row;
}

export interface ChatMemberHit { agent_id: string; row: number; start: number; end: number }

export interface ChatFrame {
  human_messages?: AttentionHit[];
  attention?: AttentionHit[];
  inline_top?: boolean;
  history_top?: number;
  members?: ChatMemberHit[];
  lines: string[];
  cursor: { row: number; col: number };
}

// Terminal mouse reports are 1-based; frame cells are 0-based.
export function chatMemberAt(frame: ChatFrame | null, column: number, row: number): string | undefined {
  return frame?.members?.find(member => member.row === row - 1 && column - 1 >= member.start && column - 1 < member.end)?.agent_id;
}

// A bounded live panel beneath ordinary terminal output. Keep suggestions
// above the room bar so the bar stays adjacent to the prompt in every state.
export function renderInlinePanel(input: ChatScreenInput): ChatFrame {
  const width = Math.max(1, input.columns - 1);
  const height = Math.max(1, input.rows - 1);
  const attention = renderAttention(input.attention, width, input.rows, input.format);
  if (width < 4 || height < 5) {
    const lines = [...(width >= 4 ? attention.lines.slice(0, 1) : []), truncateStyled(CHAT_PROMPT + input.draft.line.replace(/\n/g, " "), width)];
    return { lines, cursor: { row: lines.length - 1, col: 0 } };
  }
  const matches = input.completions ?? [];
  const panel = input.panel ?? null;
  // In the normal terminal screen the menu occupies real terminal rows.
  // Reserve its maximum height even when closed, so suggestions never move
  // the room bar and prompt or scroll the console while someone types.
  const menuCapacity = panel ? Math.min(panel.length, Math.max(0, height - 5 - attention.lines.length)) : Math.min(MAX_MENU_ROWS, Math.max(0, height - 5 - attention.lines.length));
  const topRows = attention.lines.length + menuCapacity + 2;
  const composerCapacity = Math.max(1, Math.min(MAX_COMPOSER_ROWS, height - topRows - 2));
  const highlight = draftHighlight(input);
  const composer = layoutComposer(input.draft, width, composerCapacity, highlight);
  const selected = Math.max(0, Math.min(input.completion_index ?? 0, matches.length - 1));
  const first = Math.max(0, selected - menuCapacity + 1);
  const visible = matches.slice(first, first + menuCapacity);
  const emptyRows = menuCapacity - visible.length;
  const menu = panel ? (menuCapacity ? panel.slice(-menuCapacity).map((line) => truncateStyled(line, width)) : []) : Array.from({ length: menuCapacity }, (_, row) => {
    if (row < emptyRows) return "";
    const index = first + row - emptyRows;
    const entry = matches[index];
    if (!entry) return "";
    const active = index === selected;
    return completionRow(input, entry, active, width, highlight);
  });
  const rule = dim(input.format, "─".repeat(width));
  const title = input.room_path ? roomTitle(input, Math.max(1, width - 4)) : "";
  const roomBar = title
    ? truncateStyled(`${dim(input.format, "─ ")}${title}${dim(input.format, " " + "─".repeat(Math.max(0, width - textWidth(title) - 3)))}`, width)
    : rule;
  const top = [...attention.lines, "", ...menu, roomBar];
  const lines = [...top, ...composer.rows, rule, renderFooter(input, width)];
  return {
    lines,
    attention: attention.hits,
    cursor: { row: topRows + composer.cursor_row, col: Math.min(width - 1, composer.cursor_col) }
  };
}

/** A normal-screen viewport with pins above the flowing transcript. */
export function renderInlineTopPanel(input: ChatScreenInput): ChatFrame {
  const pending = untraversedAttention(input);
  return resolveAttentionFrame(pending, attention => {
    const frame = renderInlineTopPanelFrame({ ...input, attention });
    return { frame, visible: (frame.human_messages ?? []).map(hit => hit.event_seq) };
  });
}

function renderInlineTopPanelFrame(input: ChatScreenInput): ChatFrame {
  const width = Math.max(1, input.columns - 1);
  const pins = renderAttention(input.attention, width, input.rows, input.format);
  const footer = renderInlinePanel({ ...input, attention: undefined, rows: input.rows - pins.lines.length });
  const context = input.format;
  const height = Math.max(0, input.rows - footer.lines.length - pins.lines.length);
  const body = input.transcript.viewport(height, width, context);
  const filtered = input.transcript.historyRows(width, context);
  const full = input.transcript.historyRows(width, input.format);
  const positions = new Map(full.map((row, index) => [`${row.block_id}:${row.line}:${row.start}`, index]));
  const first = filtered.slice(Math.max(0, filtered.length - height)).find(row => positions.has(`${row.block_id}:${row.line}:${row.start}`));
  const top = first ? positions.get(`${first.block_id}:${first.line}:${first.start}`)! : full.length;
  return {
    lines: [...pins.lines, ...body, ...footer.lines],
    cursor: { row: pins.lines.length + body.length + footer.cursor.row, col: footer.cursor.col },
    attention: pins.hits,
    human_messages: input.transcript.humanMessageRows(height, width, context)
      .map(hit => ({ ...hit, row: hit.row + pins.lines.length })),
    inline_top: true,
    history_top: Math.max(0, top)
  };
}

export function inlineCursorRow(frame: ChatFrame, columns: number): number {
  const width = Math.max(1, columns);
  return frame.lines.slice(0, frame.cursor.row)
    .reduce((rows, line) => rows + Math.max(1, Math.ceil(textWidth(line) / width)), 0)
    + Math.floor(frame.cursor.col / width);
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

export function chatWheelRegion(
  input: Pick<ChatScreenInput, "columns" | "rows" | "draft" | "room_path">,
  row: number
): "transcript" | "prompt" | null {
  if (input.columns < 5 || input.rows < 4 || row < 1 || row > input.rows) return null;
  const header = roomHeaderRows(input);
  const transcriptEnd = header + chatTranscriptHeight(input);
  if (row > header && row <= transcriptEnd) return "transcript";
  // A separator sits between the transcript and composer; the final two
  // rows are the lower separator and footer.
  if (row > transcriptEnd + 1 && row <= input.rows - 2) return "prompt";
  return null;
}

// The active room's path, shortened from the left, then the strip of other
// rooms when there is room for both.
function roomTitle(input: Pick<ChatScreenInput, "room_path" | "room_strip" | "format">, width: number): string {
  const strip = input.room_strip ?? "";
  const stripWidth = strip ? textWidth(strip) + 3 : 0;
  if (!strip || width - stripWidth < 16) return roomHeader(input.room_path!, width, input.format);
  return `${roomHeader(input.room_path!, width - stripWidth, input.format)}${dim(input.format, " │ ")}${strip}`;
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
  if (!input.transcript.following && !input.attention?.reviewing) return renderChatScreenFrame({ ...input, attention: undefined });
  return resolveAttentionFrame(untraversedAttention(input), attention => {
    const frame = renderChatScreenFrame({ ...input, attention });
    const width = Math.max(1, input.columns - 1);
    const pins = renderAttention(attention, width, input.rows, input.format);
    const height = Math.max(0, chatTranscriptHeight(input) - pins.lines.length);
    const context = input.format;
    // A menu overlays recent rows; it must not turn a covered message into
    // an off-the-top pin or move it away from its original timeline position.
    return { frame, visible: input.transcript.humanMessageRows(height, width, context).map(hit => hit.event_seq) };
  });
}

function untraversedAttention(input: ChatScreenInput): HumanAttention | undefined {
  if (input.attention?.reviewing) return input.attention;
  return input.attention && { ...input.attention,
    messages: input.attention.messages.filter(event => !input.transcript.wasManuallyTraversed(event.event_seq)) };
}

function renderChatScreenFrame(input: ChatScreenInput): ChatFrame {
  const width = Math.max(1, input.columns - 1);
  const height = Math.max(1, input.rows);
  const context = input.format;
  const highlight = draftHighlight(input);

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
    Math.min(MAX_COMPOSER_ROWS, height - 3 - roomHeaderRows(input)),
    highlight
  );
  const attention = renderAttention(input.attention, width, height, context);
  const bodyContext = context;
  const transcriptHeight = Math.max(0, chatTranscriptHeight(input) - attention.lines.length);
  const menuCapacity = Math.min(MAX_MENU_ROWS, Math.max(0, transcriptHeight - (transcriptHeight > 1 ? 1 : 0)));
  const completions = input.completions ?? getChatCompletions(input.draft, []);
  const selected = Math.max(0, Math.min(input.completion_index ?? 0, completions.length - 1));
  const first = Math.max(0, selected - menuCapacity + 1);
  const menuRows = input.panel
    ? (transcriptHeight > 1 ? input.panel.slice(-(transcriptHeight - 1)).map((line) => truncateStyled(line, width)) : [])
    : completions.slice(first, first + menuCapacity).map((entry, index) => {
      const active = first + index === selected;
      return completionRow(input, entry, active, width, highlight);
    });

  const rule = dim(context, "─".repeat(width));
  const memberHits: ChatMemberHit[] = [];
  const footer = renderFooter(input, width, (agent_id, start, end) => memberHits.push({ agent_id, row: height - 1, start, end }));

  const fixed = [rule, ...composer.rows, rule, footer];

  const transcript = input.transcript.viewport(
    transcriptHeight,
    width,
    bodyContext
  );
  // Occlude the transcript's bottom rows with a blank separator and the menu;
  // keep the selection visible even if only one menu row fits.
  if (menuRows.length > 0 && transcript.length > 0) {
    const overlay = [...(transcriptHeight > 1 ? [""] : []), ...menuRows];
    transcript.splice(transcript.length - overlay.length, overlay.length, ...overlay);
  }
  const header = roomHeaderRows(input) ? [roomTitle({ ...input, format: context }, width)] : [];
  const lines = [...header, ...attention.lines, ...transcript, ...fixed]
    .slice(-height)
    .map((line) => truncateStyled(line, width));
  const composerTop = lines.length - composer.rows.length - 2;

  return {
    lines,
    members: memberHits,
    attention: attention.hits.map(hit => ({ ...hit, row: hit.row + header.length })),
    human_messages: input.transcript.humanMessageRows(transcriptHeight, width, bodyContext)
      .filter(hit => hit.row < transcriptHeight - (menuRows.length ? menuRows.length + 1 : 0))
      .map(hit => ({ ...hit, row: hit.row + header.length + attention.lines.length })),
    cursor: {
      row: Math.min(height - 1, Math.max(0, composerTop + composer.cursor_row)),
      col: Math.min(width, composer.cursor_col)
    }
  };
}

function renderFooter(input: ChatScreenInput, width: number, onMember?: (agent_id: string, start: number, end: number) => void): string {
  const context = input.format;
  const transcript = input.transcript;
  let suffix = "";
  if (!transcript.following) {
    const label =
      transcript.unread > 0
        ? `↓ ${transcript.unread} new · ctrl+end`
        : "scrolled · ctrl+end";
    suffix = paintStyle(context.color, `1;${themeStyle("warn", context.color_mode)}`, label);
  } else if ((input.completions?.length ?? 0) > 0) {
    suffix = dim(context, /^\/go(?:\s|$)/i.test(input.draft.line)
      ? "↑↓ choose · Enter open · Tab fill"
      : "↑↓ choose · Tab accept · Esc clear");
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
      ? formatChatStatus({ ...input.status, columns: statusWidth + 1 }, context, onMember)
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
