import {
  HUMAN_CHAT_SESSION_KIND,
  type AgentId,
  type RoomEvent,
  type RoomMember
} from "../types.js";

export type ChatInput =
  | { kind: "empty" }
  // to lists every @name selector in the message; empty means broadcast.
  | { kind: "send"; to: string[]; body: string; interrupt: boolean }
  | { kind: "command"; name: string; args: string }
  | { kind: "error"; message: string };

export interface ChatFormatContext {
  self_agent_id: AgentId;
  name_of: (agentId: AgentId) => string;
  color: boolean;
  show_turn_events: boolean;
}

const ANSI_PATTERN =
  // CSI, OSC (BEL or ST terminated), and single-character escape sequences.
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

// 256-color foregrounds. Known harnesses keep a stable color across rooms so
// the operator learns "orange is claude"; unknown ids hash into the palette.
const HARNESS_COLORS: Record<string, number> = {
  claude: 209,
  codex: 78,
  gemini: 75,
  antigravity: 141,
  grok: 177,
  opencode: 44,
  human: 220
};
const FALLBACK_COLORS = [81, 214, 170, 114, 39, 203, 229, 147];

// Message bodies and names are written by other processes; strip escape and
// control sequences so a peer cannot repaint or hijack the operator terminal.
export function sanitizeChatText(text: string): string {
  return text
    .replace(ANSI_PATTERN, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(CONTROL_PATTERN, "");
}

export function parseChatInput(line: string): ChatInput {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return { kind: "empty" };
  }

  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    const text = trimmed.startsWith("//") ? trimmed.slice(1) : trimmed;
    return parseMessage(text, false);
  }

  const [rawName] = trimmed.slice(1).split(/\s+/);
  const name = rawName.toLowerCase();
  const args = trimmed.slice(1 + rawName.length).trim();

  switch (name) {
    case "to":
    case "dm":
    case "msg": {
      // The first word names the recipient with or without a leading @.
      const selector = args.split(/\s+/, 1)[0] ?? "";
      if (!selector || selector.startsWith("@")) {
        return parseMessage(args, false, true);
      }
      return parseMessage(`@${args}`, false, true);
    }
    case "all":
    case "room":
      return args.length > 0
        ? { kind: "send", to: [], body: args, interrupt: false }
        : { kind: "error", message: `Usage: /${name} <message>` };
    case "interrupt":
    case "int":
      return args.length > 0
        ? parseMessage(args, true)
        : { kind: "error", message: "Usage: /interrupt [@agent] <message>" };
    default:
      return { kind: "command", name, args };
  }
}

// A mention is @name at the start of the text or after a non-word character,
// so email addresses (a@b.com) stay plain text. Mentions inside `code` spans
// are ignored. Trailing punctuation (@codex, @claude:) is not part of the name.
// !@name marks the whole message as an interrupt; a bare !@ interrupts without
// naming anyone. @everyone (or @all) addresses every agent in the room.
const NAME = "[\\p{L}\\p{N}_][\\p{L}\\p{N}_:.-]*";
const MENTION_PATTERN = new RegExp(`(^|[^\\p{L}\\p{N}_@.!])(!?)@(${NAME})?`, "gu");
const LEADING_MENTIONS = new RegExp(`^(?:!?@(?:${NAME})?[,;:]?(?:\\s+|$))+`, "u");
const ADJACENT_MENTIONS = new RegExp(`(?:^|[^\\p{L}\\p{N}_@.!])!?@${NAME}!?@`, "u");
export const EVERYONE_SELECTORS: readonly string[] = ["everyone", "all"];

function parseMessage(text: string, interrupt: boolean, requireRecipient = false): ChatInput {
  const withoutCode = text.replace(/`[^`]*`/g, (span) => " ".repeat(span.length));
  if (ADJACENT_MENTIONS.test(withoutCode)) {
    return { kind: "error", message: "Separate mentions with spaces, like @claude @codex." };
  }
  const selectors: string[] = [];
  let urgent = interrupt;
  let mentioned = false;
  for (const match of withoutCode.matchAll(MENTION_PATTERN)) {
    const bang = match[2] === "!";
    const selector = (match[3] ?? "").replace(/[.:-]+$/, "").toLowerCase();
    if (!bang && !selector) continue;
    mentioned = true;
    if (bang) urgent = true;
    if (selector && !selectors.includes(selector)) selectors.push(selector);
  }
  if (/^!?@/.test(text) && !mentioned) {
    return { kind: "error", message: "Usage: @agent <message>" };
  }
  if (requireRecipient && selectors.length === 0) {
    return { kind: "error", message: "Usage: /to <agent> <message>" };
  }
  const body = text.replace(LEADING_MENTIONS, "").trim();
  if (body.length === 0) {
    return { kind: "error", message: "Usage: @agent <message>" };
  }
  return { kind: "send", to: selectors, body, interrupt: urgent };
}

// Resolves every selector before anything is sent, so one typo can't deliver a
// message to only some of the intended recipients.
export function resolveChatRecipients(
  selectors: string[],
  members: RoomMember[],
  selfAgentId: AgentId
): { agent_ids: AgentId[] } | { error: string; unmatched: string[] } {
  const agentIds: AgentId[] = [];
  const unmatched: string[] = [];
  for (const selector of selectors) {
    const resolved = EVERYONE_SELECTORS.includes(selector)
      ? everyoneIn(members, selfAgentId)
      : resolveChatRecipient(selector, members, selfAgentId);
    if ("error" in resolved) {
      unmatched.push(selector);
      continue;
    }
    for (const agentId of resolved.agent_ids) {
      if (!agentIds.includes(agentId)) agentIds.push(agentId);
    }
  }
  if (unmatched.length > 0) {
    return {
      error: `No room member matches ${unmatched.map((selector) => `'@${selector}'`).join(", ")}.`,
      unmatched
    };
  }
  return { agent_ids: agentIds };
}

// Short, human names: the harness prefix ("codex") when it is unique among the
// known agents, otherwise the full agent id so two sessions stay distinguishable.
export function buildNameResolver(
  agentIds: Iterable<AgentId>,
  selfAgentId: AgentId,
  displayNames: ReadonlyMap<AgentId, string> = new Map()
): (agentId: AgentId) => string {
  const ids = [...new Set(agentIds)];
  const prefixCounts = new Map<string, number>();
  for (const id of ids) {
    const prefix = displayNames.get(id) ?? agentPrefix(id);
    prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
  }

  return (agentId) => {
    if (agentId === selfAgentId) {
      return "you";
    }
    const prefix = displayNames.get(agentId) ?? agentPrefix(agentId);
    const count = prefixCounts.get(prefix) ?? 0;
    return sanitizeChatText(count <= 1 ? prefix : agentId);
  };
}

function agentPrefix(agentId: AgentId): string {
  const index = agentId.indexOf(":");
  return index > 0 ? agentId.slice(0, index) : agentId;
}

export function resolveChatRecipient(
  selector: string,
  members: RoomMember[],
  selfAgentId: AgentId
): { agent_ids: AgentId[] } | { error: string } {
  const lowered = selector.toLowerCase();
  const matches = members.filter(
    (member) =>
      member.agent_id !== selfAgentId &&
      (member.agent_id.toLowerCase().startsWith(lowered) ||
        member.display_name?.toLowerCase().startsWith(lowered))
  );
  return matches.length > 0
    ? { agent_ids: matches.map((member) => member.agent_id) }
    : { error: `No room member matches '${selector}'.` };
}

function everyoneIn(
  members: RoomMember[],
  selfAgentId: AgentId
): { agent_ids: AgentId[] } | { error: string } {
  const agents = members.filter(
    (member) =>
      member.agent_id !== selfAgentId &&
      member.status === "active" &&
      member.session_kind !== HUMAN_CHAT_SESSION_KIND
  );
  return agents.length > 0
    ? { agent_ids: agents.map((member) => member.agent_id) }
    : { error: "No agents are in the room." };
}

export function formatChatEvent(
  event: RoomEvent,
  context: ChatFormatContext
): string | null {
  const time = formatClock(event.created_at);
  const from = event.from_agent_id;
  const to = event.to_agent_id;

  if (event.event_type === "message_sent") {
    const body = sanitizeChatText(event.payload?.body ?? "").replace(
      /\s+$/,
      ""
    );
    const sender = from ? formatChatAgent(context, from) : "?";
    const route = to ? ` → ${formatChatAgent(context, to)}` : "";
    const marker =
      event.payload?.delivery_hint === "interrupt"
        ? ` ${paint(context, "1;31", "‼ interrupt")}`
        : "";
    const header = `${sender}${route}${marker}  ${paint(context, "2", time)}`;
    return [header, ...body.split("\n").map((line) => `  ${line}`)].join("\n");
  }

  const system = describeSystemEvent(event, context);
  if (!system) {
    return null;
  }
  return paint(context, "2", `· ${system}  ${time}`);
}

function describeSystemEvent(
  event: RoomEvent,
  context: ChatFormatContext
): string | null {
  const name = (agentId: AgentId | null) =>
    agentId ? context.name_of(agentId) : "someone";

  switch (event.event_type) {
    case "join":
      return `${name(event.from_agent_id)} joined`;
    case "leave":
      return `${name(event.from_agent_id)} left`;
    case "kick":
      return `${name(event.to_agent_id)} was removed by ${name(event.from_agent_id)}`;
    case "close":
      return "room closed";
    case "session_superseded":
      return context.show_turn_events
        ? `${name(event.to_agent_id ?? event.from_agent_id)} restarted its session`
        : null;
    default:
      break;
  }

  if (!context.show_turn_events) {
    return null;
  }

  const summary = event.handoff?.status
    ? `: ${truncate(sanitizeChatText(event.handoff.status).split("\n")[0], 120)}`
    : "";
  switch (event.event_type) {
    case "claim":
      return `${name(event.to_agent_id)} took the stick (turn ${event.turn_id})`;
    case "release":
      return `${name(event.from_agent_id)} released the stick${summary}`;
    case "pass":
      return event.to_agent_id
        ? `${name(event.from_agent_id)} passed the stick to ${name(event.to_agent_id)}${summary}`
        : `${name(event.from_agent_id)} passed the stick${summary}`;
    case "takeover":
      return `${name(event.to_agent_id)} took over the stick${event.reason ? ` (${sanitizeChatText(event.reason)})` : ""}`;
    case "reservation_expired":
      return `reservation for ${name(event.to_agent_id ?? event.from_agent_id)} expired`;
    default:
      return null;
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "--:--";
  }
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function formatChatAgent(
  context: ChatFormatContext,
  agentId: AgentId
): string {
  return paint(
    context,
    `1;38;5;${agentColor(agentId)}`,
    context.name_of(agentId)
  );
}

export function agentColor(agentId: AgentId): number {
  return (
    HARNESS_COLORS[agentPrefix(agentId).toLowerCase()] ??
    FALLBACK_COLORS[hashString(agentId) % FALLBACK_COLORS.length]
  );
}

function paint(context: ChatFormatContext, code: string, text: string): string {
  return context.color ? `\u001b[${code}m${text}\u001b[0m` : text;
}

function hashString(text: string): number {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash;
}

export interface ChatStatusInput {
  members: RoomMember[];
  owner: AgentId | null;
  owner_since: string | null;
  reserved_for: AgentId | null;
  now: Date;
  columns: number;
}

// One dim line of room state for the operator: member count, then each agent
// with the single most useful fact (holding the stick, up next, standby,
// away, or how long since its last tt command). Observers are not listed.
export function formatChatStatus(
  input: ChatStatusInput,
  context: ChatFormatContext
): string {
  const agents = input.members
    .filter((member) => member.session_kind !== HUMAN_CHAT_SESSION_KIND)
    .sort((left, right) => rankMember(left, input) - rankMember(right, input));

  const count = `${input.members.length} ${input.members.length === 1 ? "member" : "members"}`;
  const budget = Math.max(0, input.columns - 1);
  if (count.length > budget) {
    return paint(context, "2", String(input.members.length).slice(0, budget));
  }
  const safeContext = {
    ...context,
    name_of: (id: AgentId) =>
      sanitizeChatText(context.name_of(id)).replace(/\s+/g, " ")
  };
  const segments = agents.map((member) => ({
    plain: `${safeContext.name_of(member.agent_id)} ${describeMemberState(member, input)}`,
    painted: `${formatChatAgent(safeContext, member.agent_id)} ${paint(context, "2", describeMemberState(member, input))}`
  }));
  let width = count.length;
  let result = paint(context, "2", count);
  for (const [index, segment] of segments.entries()) {
    const separator = index === 0 ? " │ " : " · ";
    const remaining = segments.length - index - 1;
    const reserve = remaining > 0 ? ` · +${remaining}`.length : 0;
    if (
      width + separator.length + chatTextWidth(segment.plain) + reserve >
      budget
    ) {
      const more = `${separator}+${segments.length - index}`;
      if (width + more.length <= budget) result += paint(context, "2", more);
      break;
    }
    result += paint(context, "2", separator) + segment.painted;
    width += separator.length + chatTextWidth(segment.plain);
  }
  return result;
}

// Conservatively reserve two cells for non-ASCII names. Combining marks
// occupy no additional cells; overestimating a narrow glyph keeps the footer safe.
export function chatTextWidth(text: string): number {
  return Array.from(text).reduce((width, char) => {
    if (/\p{Mark}|[\u200d\ufe0f]/u.test(char)) return width;
    return width + (/^[\x20-\x7e│·]$/.test(char) ? 1 : 2);
  }, 0);
}

function rankMember(member: RoomMember, input: ChatStatusInput): number {
  if (member.agent_id === input.owner) return 0;
  if (member.agent_id === input.reserved_for) return 1;
  return member.status === "active" ? 2 : 3;
}

function describeMemberState(
  member: RoomMember,
  input: ChatStatusInput
): string {
  if (member.agent_id === input.owner) {
    return input.owner_since
      ? `holding ${formatDuration(input.now, input.owner_since)}`
      : "holding";
  }
  if (member.agent_id === input.reserved_for) {
    return "up next";
  }
  if (member.status !== "active") {
    return "away";
  }
  if (member.standby_transport) {
    return "standby";
  }
  const idleMs = input.now.getTime() - Date.parse(member.last_seen_at);
  return idleMs < 60_000
    ? "active"
    : `idle ${formatDuration(input.now, member.last_seen_at)}`;
}

export function formatDuration(now: Date, sinceIso: string): string {
  const seconds = Math.max(
    0,
    Math.floor((now.getTime() - Date.parse(sinceIso)) / 1000)
  );
  if (Number.isNaN(seconds)) return "?";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
