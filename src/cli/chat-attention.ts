import { osc8 } from "./chat-links.js";
import type { RoomEvent } from "../types.js";
import { formatChatAgent, formatDuration, sanitizeChatText, type ChatFormatContext } from "./chat-format.js";
import { themeStyle } from "./theme.js";
import { textWidth, truncateStyled } from "./chat-view.js";

export interface HumanAttention {
  messages: RoomEvent[]; total: number; acknowledged?: number[];
  /** Set while the operator walks the unread queue in its original timeline. */
  reviewing?: boolean; visited?: number;
  /** The landed message, its 1-based position, and the queue length so far. */
  current?: RoomEvent; position?: number; queued?: number;
}
export interface AttentionHit { event_seq: number; row: number }

/** One row of chrome on the unread band (plus a spacer): a navigation control, never a
 * second copy of an authored message. Optional segments drop from the right
 * so the count survives any width.
 */
export function renderAttention(attention: HumanAttention | undefined, width: number, rows: number,
  context: ChatFormatContext): { lines: string[]; hits: AttentionHit[] } {
  if (!attention || (!attention.messages.length && !attention.reviewing) || rows < 4) return { lines: [], hits: [] };
  const oldest = [...attention.messages].sort((a, b) => a.event_seq - b.event_seq)[0];
  const next = oldest?.event_seq ?? attention.visited;
  const paint = (style: string, text: string) => context.color ? `\u001b[${style}m${text}\u001b[0m` : text;
  const muted = (text: string) => paint(themeStyle("muted", context.color_mode), text);
  const accent = (text: string) => paint(`1;${themeStyle("accent", context.color_mode)}`, text);
  const age = (event: RoomEvent) => muted(formatDuration(context.now ?? new Date(), event.created_at));
  const sender = (event: RoomEvent | undefined) => event?.from_agent_id ? formatChatAgent(context, event.from_agent_id) : undefined;
  let label: string;
  if (!attention.messages.length) {
    label = fit([`${paint(themeStyle("ok", context.color_mode), "✓")} All caught up`, muted("Esc live")], width, muted);
  } else if (attention.reviewing) {
    const current = attention.current;
    label = fit([accent(`▲ ${attention.position ?? 1} of ${attention.queued ?? attention.messages.length}`),
      current && `${sender(current)} ${age(current)}`, muted("^G next · Esc live")], width, muted);
  } else {
    // Like a pinned prompt: one line of the message the control visits next.
    const head = [accent(`▲ ${attention.messages.length} for you`), sender(oldest)].filter(Boolean).join(" · ");
    const preview = sanitizeChatText(String(oldest.payload?.body ?? "")).split("\n").map(line => line.trim()).find(Boolean) ?? "";
    // The preview outranks the hint, and the hint outranks nothing else.
    const tails: Array<[string[], number]> = [[[age(oldest), muted("^G")], 24], [[age(oldest)], 10], [[], 0]];
    label = ` ${head} `;
    for (const [tail, minimum] of tails) {
      const suffix = tail.length ? ` ${tail.join(muted(" · "))} ` : "";
      const room = width - textWidth(` ${head} › `) - textWidth(suffix);
      if (room < Math.min(minimum, textWidth(preview))) continue;
      label = room > 0 && preview ? ` ${head} ${muted("›")} ${ellipsize(preview, room)}${suffix}` : ` ${head}${suffix}`;
      break;
    }
    label = truncateStyled(label, width);
  }
  const content = context.color ? band(label, width, context) : label;
  const url = next === undefined ? undefined : context.pin_link?.(next);
  // A blank row keeps a clipped transcript line from reading as the preview's continuation.
  const lines = [url ? osc8(content, url) : content, ...(rows >= 8 ? [""] : [])];
  return { lines, hits: next === undefined ? [] : [{ event_seq: next, row: 0 }] };
}

// Optional segments drop from the right so the leading count survives any width.
function fit(segments: Array<string | undefined>, width: number, muted: (text: string) => string): string {
  const parts = segments.filter((part): part is string => Boolean(part));
  const join = (list: string[]) => ` ${list.join(muted(" · "))} `;
  while (parts.length > 1 && textWidth(join(parts)) > width) parts.splice(parts.length > 2 ? -1 : 1, 1);
  return truncateStyled(join(parts), width);
}

function ellipsize(text: string, width: number): string {
  return textWidth(text) <= width ? text : truncateStyled(text, Math.max(0, width - 1)).trimEnd() + "…";
}

// The same background as an unread message in the transcript, across the row.
function band(text: string, width: number, context: ChatFormatContext): string {
  const background = `\u001b[${themeStyle("attention", context.color_mode, true)}m`;
  return background + text.replace(/\u001b\[0m/g, `\u001b[0m${background}`) +
    " ".repeat(Math.max(0, width - textWidth(text))) + "\u001b[0m";
}

/** Only promote messages whose original is outside the visible transcript.
 * Adding pins can push another original out; grow the set until layout settles.
 */
export function resolveAttentionFrame<T>(attention: HumanAttention | undefined,
  render: (pins: HumanAttention | undefined) => { frame: T; visible: Iterable<number> }): T {
  if (!attention?.messages.length || attention.reviewing) return render(attention).frame;
  const pinned = new Set<number>();
  for (;;) {
    const result = render({ ...attention, messages: attention.messages.filter(event => pinned.has(event.event_seq)) });
    const visible = new Set(result.visible);
    const missing = attention.messages.filter(event => !visible.has(event.event_seq) && !pinned.has(event.event_seq));
    if (!missing.length) return result.frame;
    for (const event of missing) pinned.add(event.event_seq);
  }
}
