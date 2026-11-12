import fs from "node:fs";
import path from "node:path";
import { ROOM_DECLARATION_FILE, insideNestedRepository, isWithinOrSame, readDeclaration, resolveContextPath } from "../path-resolution.js";
import { HUMAN_CHAT_SESSION_KIND } from "../types.js";
import type { PathRoom, RoomActivity, RoomMember } from "../types.js";
import { formatRelativeTime, printResult } from "./output.js";
import { getStringOption, hasOption, parseOptionalInteger, type ParsedCommand } from "./parser.js";
import { resolveRoomSelector, roomShortName, selectedRoom } from "./room-selector.js";
import type { Runtime } from "./runtime.js";
import { askRoom, readReplies } from "./visitor-commands.js";

// `tt room create|list|adopt|remove`. Declarations are files in the checkout;
// the database row for a declared room appears on its first join.
export function handleRoomCommand(runtime: Runtime, parsed: ParsedCommand): void | Promise<void> {
  const [action, target, ...rest] = parsed.positionals;
  switch (action) {
    case "ask":
      if (!target) throw new Error("Usage: tt room ask <room> --to <agent[,agent]|room> <body...> [--stdin] [--request-key KEY]");
      return askRoom(runtime, parsed, briefTarget(runtime, parsed, target), rest);
    case "replies": return readReplies(runtime, parsed, target);
    case "create": return createRoom(runtime, parsed, target);
    case "ensure": return ensureRoom(runtime, parsed, target);
    case "list": return hasOption(parsed, "all") ? listHostRooms(runtime, parsed) : listRooms(runtime, parsed, target);
    case "brief": return briefRoom(runtime, parsed, target);
    case "adopt": return adoptRoom(runtime, parsed, target);
    case "remove": return removeRoom(runtime, parsed, target);
    default:
      throw new Error("Usage: tt room create [path] [--name NAME] | ensure <path> [--name NAME] | list [path] [--all] | brief [room] [--limit N] [--before SEQ] | ask <room> --to <agents|room> <body> | replies <request-id> [--timeout S] | adopt [path] | remove [path]");
  }
}

function declarationFile(directory: string): string {
  return path.join(directory, ROOM_DECLARATION_FILE);
}

class DeclarationExistsError extends Error {}

function validateRoomName(name: string | undefined): void {
  if (name !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error(`Invalid room name ${JSON.stringify(name)}: use letters, digits, '.', '_' or '-'.`);
  }
}

// The file appears complete or not at all: it is written aside and linked
// into place, so a concurrent writer or reader never sees a partial file, and
// an existing declaration is never overwritten.
function writeDeclaration(directory: string, name: string | undefined): string {
  validateRoomName(name);
  const file = declarationFile(directory);
  if (fs.existsSync(file)) throw new DeclarationExistsError(`${file} already declares a room.`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const staged = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(staged, `# Talking Stick room boundary. Commit this file to share the layout.\n${name ? `name = "${name}"\n` : ""}`);
  try {
    fs.linkSync(staged, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new DeclarationExistsError(`${file} already declares a room.`);
    throw error;
  } finally {
    fs.rmSync(staged, { force: true });
  }
  return file;
}

export function createDeclaredRoom(runtime: Runtime, target: string, name?: string): { room: PathRoom; file: string } {
  const directory = resolveContextPath(target).canonical_context_path;
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${directory} is not a directory.`);
  }
  const file = writeDeclaration(directory, name);
  // Open the row now so `--in <name>` and `tt up --in` work before any join.
  let room: PathRoom;
  try {
    room = runtime.commands.openRoom({ context_path: directory });
  } catch (error) {
    fs.rmSync(file, { force: true });
    try { fs.rmdirSync(path.dirname(file)); } catch { /* .talking-stick holds other files */ }
    throw error;
  }
  return { room, file };
}

function createRoom(runtime: Runtime, parsed: ParsedCommand, target: string | undefined): void {
  const directory = resolveContextPath(target ?? process.cwd()).canonical_context_path;
  const { room, file } = createDeclaredRoom(runtime, directory, getStringOption(parsed, "name"));
  const resolved = resolveContextPath(directory);
  const result = { status: "created", declaration: file, room_id: room.room_id, room_path: resolved.room_path,
    rel_path: resolved.declaration?.rel_path ?? "", name: resolved.declaration?.name ?? path.basename(directory) };
  printResult(parsed, result, () => [
    `Declared room ${result.name} at ${directory}.`,
    `Agents that join from inside it now use this room; members of a parent room move only when they join again.`,
    `Commit ${path.relative(resolved.checkout_root ?? directory, file)} to share it.`
  ].join("\n"));
}

// Idempotent create for launchers: declares the directory unless it already
// declares a room, and returns the same room either way. It never rewrites a
// declaration, joins, or takes a lease. A name that differs from the declared
// one, or a declaration it cannot read, is an error rather than a guess.
function ensureRoom(runtime: Runtime, parsed: ParsedCommand, target: string | undefined): void {
  if (!target) throw new Error("Usage: tt room ensure <path> [--name NAME]");
  const name = getStringOption(parsed, "name");
  validateRoomName(name);
  const directory = resolveContextPath(target).canonical_context_path;
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${directory} is not a directory.`);
  }
  let status: "created" | "exists" = "exists";
  if (!fs.existsSync(declarationFile(directory))) {
    try {
      writeDeclaration(directory, name);
      status = "created";
    } catch (error) {
      // Another ensure declared it first; validate theirs like any other.
      if (!(error instanceof DeclarationExistsError)) throw error;
    }
  }
  const file = declarationFile(directory);
  // Content tt does not understand still declares the room, as for a join.
  const declared = readDeclaration(file);
  if (name !== undefined && declared.name !== name) {
    throw new Error(`${file} already declares ${declared.name ? `the room name ${JSON.stringify(declared.name)}` : "a room without a name"}, not ${JSON.stringify(name)}.`);
  }
  const resolved = resolveContextPath(directory);
  if (resolved.declaration?.directory !== directory) {
    throw new Error(`${file} does not declare a room for ${directory}.`);
  }
  const room = runtime.commands.openRoom({ context_path: directory });
  const result = { status, room_id: room.room_id, room_path: room.canonical_path, rel_path: resolved.declaration.rel_path,
    name: resolved.declaration.name ?? path.basename(directory), declaration: file,
    ...(declared.problem ? { warning: declared.problem } : {}) };
  printResult(parsed, result, () => [
    `${status === "created" ? "Declared" : "Found"} room ${result.name} at ${directory}.`,
    ...(declared.problem ? [`Warning: ${declared.problem}`] : []),
    `Pin agents to it with TT_ROOM=${result.room_path}; it reopens on join after it empties.`
  ].join("\n"));
}

interface RoomListing {
  name: string;
  room_id: string;
  canonical_path: string;
  state: PathRoom["state"];
  owner: string | null;
  kind: "root" | "declared" | "legacy";
  /** This caller's room for the given path. */
  current: boolean;
  /** Live agents (not chat consoles), so a harness knows who works where. */
  agents: string[];
}

// Read without an agent id so listing never refreshes the caller's presence
// in other rooms. A parked agent can be inactive by recency yet alive.
function liveMembers(runtime: Runtime, roomId: string): RoomMember[] {
  return runtime.commands.getRoomState({ room_id: roomId }).members
    .filter((member) => member.process_liveness !== "gone" &&
      (member.status === "active" || member.process_liveness === "alive"));
}

// Long enough to say what the room is doing; the full handoff belongs to a
// per-room read, so a host-wide listing stays small.
const HANDOFF_EXCERPT_CHARS = 160;

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > HANDOFF_EXCERPT_CHARS ? `${flat.slice(0, HANDOFF_EXCERPT_CHARS - 1)}…` : flat;
}

// Every room on this host with someone in it, newest activity first, for an
// observer outside any repository. Reads only: it never joins a room.
function listHostRooms(runtime: Runtime, parsed: ParsedCommand): void {
  const rooms = runtime.commands.listRooms({}).rooms
    .filter((room) => room.state !== "closed")
    .map((room) => {
      const members = liveMembers(runtime, room.room_id);
      const activity = runtime.commands.getRoomActivity({ room_id: room.room_id });
      const handoff = activity.last_handoff;
      return {
        name: roomShortName(room),
        room_id: room.room_id,
        canonical_path: room.canonical_path,
        state: room.state,
        owner: room.owner,
        agents: members.filter((member) => member.session_kind !== HUMAN_CHAT_SESSION_KIND).map((member) => member.agent_id),
        consoles: members.filter((member) => member.session_kind === HUMAN_CHAT_SESSION_KIND).map((member) => member.agent_id),
        // Room activity, not conversation progress: the row also changes on
        // lease renewals, and events cover messages and handoffs.
        last_activity_at: [activity.last_event_at, room.updated_at].filter((at): at is string => at !== null).sort().at(-1)!,
        last_handoff: handoff && {
          event_seq: handoff.event_seq,
          event_type: handoff.event_type,
          from_agent_id: handoff.from_agent_id,
          to_agent_id: handoff.to_agent_id,
          created_at: handoff.created_at,
          status: excerpt(handoff.handoff.status),
          next_action: excerpt(handoff.handoff.next_action)
        }
      };
    })
    .filter((room) => room.agents.length > 0 || room.consoles.length > 0)
    .sort((left, right) => right.last_activity_at.localeCompare(left.last_activity_at));
  printResult(parsed, { rooms }, () => rooms.length === 0
    ? "No rooms on this host have live members."
    : rooms.map((room) => {
      const who = [room.agents.join(", ") || "no agents", room.consoles.length > 0 ? `${room.consoles.length} console${room.consoles.length === 1 ? "" : "s"}` : null]
        .filter(Boolean).join(", ");
      const lines = [`#${room.name}  ${who}${room.owner ? `  stick=${room.owner}${room.state === "stale_owner" ? " (stale)" : ""}` : ""}  active ${formatRelativeTime(room.last_activity_at)}`,
        `  ${room.canonical_path}  ${room.room_id}`];
      if (room.last_handoff) {
        lines.push(`  last handoff ${formatRelativeTime(room.last_handoff.created_at)} from ${room.last_handoff.from_agent_id ?? "unknown"}: ${room.last_handoff.status}`);
      }
      return lines.join("\n");
    }).join("\n"));
}

// Bounds that keep a brief readable in one model turn. Every clipped or older
// event stays reachable: each clipped event carries a command that reads it
// whole, and `older` pages back through earlier events.
const BRIEF_DEFAULT_MESSAGES = 20;
const BRIEF_MAX_MESSAGES = 200;
const BRIEF_BODY_CHARS = 1000;
const BRIEF_NOTES = 10;
const BRIEF_EVENT_TYPES = ["message_sent", "release", "pass", "takeover"] as const;

function clip(text: string, limit: number): { text: string; truncated: boolean } {
  return text.length > limit ? { text: `${text.slice(0, limit - 1)}…`, truncated: true } : { text, truncated: false };
}

// Explicit path syntax names a directory; anything else is a room selector,
// so `tt room brief api` never depends on what the caller's cwd contains.
function isPathSyntax(target: string): boolean {
  return target === "." || target === ".." || path.isAbsolute(target) || /^\.\.?[\\/]/.test(target);
}

// The named room, the --in/TT_ROOM room, or the caller's directory's room.
function briefTarget(runtime: Runtime, parsed: ParsedCommand, target: string | undefined): PathRoom {
  if (target !== undefined && !isPathSyntax(target)) {
    return resolveRoomSelector(runtime.commands.listRooms({}).rooms, target);
  }
  const selected = target === undefined ? selectedRoom(runtime, parsed) : null;
  if (selected) return selected;
  const directory = resolveContextPath(target ?? process.cwd()).canonical_context_path;
  const room = runtime.commands.listRooms({ context_path: directory }).rooms.find((candidate) => candidate.state !== "closed");
  if (!room) throw new Error(`No open room covers ${directory}. Run \`tt room list --all\` to see rooms.`);
  return room;
}

function memberPresence(member: { live: boolean; process_liveness: string }): string {
  return member.live ? "" : member.process_liveness === "gone" ? " (gone)" : " (inactive)";
}

// What a room is doing, for an outsider: holder, members, the latest handoff
// in full, open notes, and recent conversation. Reads only, like list --all.
function briefRoom(runtime: Runtime, parsed: ParsedCommand, target: string | undefined): void {
  const room = briefTarget(runtime, parsed, target);
  const limit = Math.min(parseOptionalInteger(parsed, "limit") ?? BRIEF_DEFAULT_MESSAGES, BRIEF_MAX_MESSAGES);
  const before = parseOptionalInteger(parsed, "before");
  const state = runtime.commands.getRoomState({ room_id: room.room_id });
  const cursor = state.cursor_event_seq;
  const live = new Set(liveMembers(runtime, room.room_id).map((member) => member.agent_id));
  const activity = runtime.commands.getRoomActivity({ room_id: room.room_id });
  const notes = runtime.commands.getOpenNotes({ room_id: room.room_id, limit: BRIEF_NOTES });
  const eventTypes = [...BRIEF_EVENT_TYPES];
  // Anchored to the state snapshot so nothing past the returned cursor shows.
  const events = runtime.commands.getRecentRoomEvents({ room_id: room.room_id, limit, event_types: eventTypes,
    before_event_seq: Math.min(before ?? cursor + 1, cursor + 1) });
  const readOne = (seq: number) => `tt events --in ${room.room_id} --after ${seq - 1} --limit 1 --target any --json`;
  const recent = events.map((event) => {
    const body = event.payload?.body === undefined ? null : clip(event.payload.body, BRIEF_BODY_CHARS);
    const handoff = event.handoff
      ? { status: clip(event.handoff.status, HANDOFF_EXCERPT_CHARS), next_action: clip(event.handoff.next_action, HANDOFF_EXCERPT_CHARS) }
      : null;
    const truncated = body?.truncated || handoff?.status.truncated || handoff?.next_action.truncated;
    return {
      event_seq: event.event_seq,
      event_type: event.event_type,
      from_agent_id: event.from_agent_id,
      to: event.to_agent_id ?? event.payload?.recipients ?? null,
      created_at: event.created_at,
      ...(body ? { body: body.text } : {}),
      ...(handoff ? { status: handoff.status.text, next_action: handoff.next_action.text } : {}),
      // A visitor's question, or an answer to one (sent to the visitor, so
      // its to is null like a room message).
      ...(event.payload?.request_id ? { request_id: event.payload.request_id } : {}),
      ...(event.payload?.in_reply_to ? { in_reply_to: event.payload.in_reply_to } : {}),
      ...(truncated ? { truncated: true, full: readOne(event.event_seq) } : {})
    };
  });
  const oldest = recent[0]?.event_seq;
  const hasOlder = oldest !== undefined && runtime.commands.getRecentRoomEvents({ room_id: room.room_id, limit: 1,
    event_types: eventTypes, before_event_seq: oldest }).length > 0;
  const brief = {
    name: roomShortName(room),
    room_id: room.room_id,
    canonical_path: room.canonical_path,
    state: state.room.state,
    owner: state.room.owner,
    reserved_for: state.room.reserved_for,
    lease_expires_at: state.room.lease_expires_at,
    members: state.members.map((member) => ({
      agent_id: member.agent_id,
      kind: member.session_kind === HUMAN_CHAT_SESSION_KIND ? "console" as const : "agent" as const,
      live: live.has(member.agent_id),
      status: member.status,
      process_liveness: member.process_liveness,
      wait_intent: member.wait_intent,
      last_seen_at: member.last_seen_at
    })),
    last_handoff: activity.last_handoff,
    notes: notes.notes.map((note) => ({
      note_id: note.note_id, author_agent_id: note.author_agent_id, created_at: note.created_at,
      body: clip(note.body, BRIEF_BODY_CHARS).text
    })),
    notes_total: notes.total,
    recent,
    older: hasOlder ? `tt room brief ${room.room_id} --before ${oldest} --limit ${limit} --json` : null,
    cursor_event_seq: cursor,
    updates_since: `tt events --in ${room.room_id} --after ${cursor} --target any --json`
  };
  printResult(parsed, brief, () => formatBrief(brief));
}

function formatBrief(brief: {
  name: string; canonical_path: string; room_id: string; state: string; owner: string | null; reserved_for: string | null;
  members: { agent_id: string; kind: string; live: boolean; process_liveness: string }[];
  last_handoff: RoomActivity["last_handoff"];
  notes: { author_agent_id: string; body: string }[]; notes_total: number;
  recent: { event_seq: number; event_type: string; from_agent_id: string | null; to: unknown; created_at: string;
    body?: string; status?: string; next_action?: string; full?: string; request_id?: string; in_reply_to?: string }[];
  older: string | null; updates_since: string;
}): string {
  const lines = [`#${brief.name}  ${brief.canonical_path}  ${brief.room_id}`];
  const stick = brief.owner ? `${brief.owner}${brief.state === "stale_owner" ? " (stale)" : ""}`
    : brief.reserved_for ? `nobody, reserved for ${brief.reserved_for}` : `nobody (${brief.state})`;
  lines.push(`stick: ${stick}`);
  lines.push(`members: ${brief.members.map((member) =>
    `${member.agent_id}${member.kind === "console" ? " (console)" : ""}${memberPresence(member)}`).join(", ") || "none"}`);
  const handoff = brief.last_handoff;
  if (handoff) {
    lines.push("", `last handoff ${formatRelativeTime(handoff.created_at)}, ${handoff.event_type} from ${handoff.from_agent_id ?? "unknown"}${handoff.to_agent_id ? ` to ${handoff.to_agent_id}` : ""}:`,
      `  status: ${handoff.handoff.status}`, `  next: ${handoff.handoff.next_action}`);
  }
  if (brief.notes.length > 0) {
    lines.push("", `open notes (newest ${brief.notes.length} of ${brief.notes_total}):`,
      ...brief.notes.map((note) => `  ${note.author_agent_id}: ${note.body.replace(/\s+/g, " ")}`));
  }
  if (brief.recent.length > 0) {
    lines.push("", "recent:");
    for (const event of brief.recent) {
      const to = event.in_reply_to ? `visitor (reply to request ${event.in_reply_to})`
        : Array.isArray(event.to) ? event.to.join(", ") : event.to ?? "room";
      const kind = event.request_id ? "visitor " : event.event_type === "message_sent" ? "" : `${event.event_type} `;
      lines.push(`  #${event.event_seq} ${formatRelativeTime(event.created_at)} ${kind}${event.from_agent_id ?? "unknown"} → ${to}${event.request_id ? ` (request ${event.request_id})` : ""}`);
      const text = event.body ?? [event.status, event.next_action && `next: ${event.next_action}`].filter(Boolean).join(" ");
      if (text.trim()) lines.push(...text.trimEnd().split("\n").map((line) => `    ${line}`));
      if (event.full) lines.push(`    (clipped; full: ${event.full})`);
    }
  }
  lines.push("");
  if (brief.older) lines.push(`older: ${brief.older}`);
  lines.push(`updates since: ${brief.updates_since}`);
  return lines.join("\n");
}

// One compact listing of the repository's rooms and who is in each, for an
// agent to read once on entry or when a task spans rooms.
function listRooms(runtime: Runtime, parsed: ParsedCommand, target: string | undefined): void {
  const resolved = resolveContextPath(target ?? process.cwd());
  // An explicit --in stays strict; a stale inherited TT_ROOM must not block
  // the discovery an agent uses to recover from it.
  let selected: PathRoom | null = null;
  try {
    selected = selectedRoom(runtime, parsed);
  } catch (error) {
    if (getStringOption(parsed, "in")) throw error;
  }
  // A room selected with --in/TT_ROOM brings its own repository (same rule as
  // chat); a keyed path absent on disk falls back to the caller's repository.
  const anchor = selected && fs.existsSync(selected.canonical_path)
    ? resolveContextPath(selected.canonical_path).workspace_root
    : resolved.workspace_root;
  const currentId = selected?.room_id ??
    runtime.commands.listRooms({ context_path: resolved.canonical_context_path }).rooms[0]?.room_id ?? null;
  const open = runtime.commands.listRooms({}).rooms
    .filter((room) => room.state !== "closed" && isWithinOrSame(room.canonical_path, anchor) &&
      !insideNestedRepository(room.canonical_path, anchor));
  const names = new Map<string, string>();
  for (const room of open) {
    const base = room.canonical_path === anchor ? "root" : roomShortName(room);
    const clash = open.some((other) => other !== room && other.canonical_path !== anchor && roomShortName(other) === base);
    names.set(room.room_id, clash ? path.relative(anchor, room.canonical_path).split(path.sep).join("/") : base);
  }
  const rooms: RoomListing[] = open.map((room) => ({
    name: names.get(room.room_id)!,
    room_id: room.room_id,
    canonical_path: room.canonical_path,
    state: room.state,
    owner: room.owner,
    kind: room.canonical_path === anchor ? "root" as const
      : fs.existsSync(declarationFile(room.canonical_path)) ? "declared" as const : "legacy" as const,
    current: room.room_id === currentId,
    agents: liveMembers(runtime, room.room_id)
      .filter((member) => member.session_kind !== HUMAN_CHAT_SESSION_KIND)
      .map((member) => member.agent_id)
  }));
  printResult(parsed, { anchor, rooms }, () => rooms.length === 0
    ? `No rooms under ${anchor}.`
    : rooms.map((room) => `${room.current ? "*" : " "} #${room.name}  ${room.kind}  ${room.agents.join(", ") || "no agents"}${room.owner ? `  stick=${room.owner}` : ""}  ${room.canonical_path}  ${room.room_id}`).join("\n"));
}

// Declare an existing legacy room's directory and key the room to it, keeping
// its id, members, lease, and history.
function adoptRoom(runtime: Runtime, parsed: ParsedCommand, target: string | undefined): void {
  const directory = resolveContextPath(target ?? process.cwd()).canonical_context_path;
  const room = runtime.commands.listRooms({}).rooms.find((candidate) =>
    candidate.state !== "closed" && candidate.canonical_path === directory);
  if (!room) throw new Error(`No room exists at ${directory}. Use \`tt room list\` to find legacy rooms, or \`tt room create\`.`);
  const before = resolveContextPath(directory);
  if (before.declaration && before.declaration.directory === directory) {
    throw new Error(`${directory} is already declared.`);
  }
  const file = writeDeclaration(directory, getStringOption(parsed, "name"));
  let rekeyed: PathRoom;
  try {
    rekeyed = runtime.commands.rekeyRoomPath({ room_id: room.room_id, canonical_path: resolveContextPath(directory).room_path });
  } catch (error) {
    fs.rmSync(file, { force: true });
    throw error;
  }
  printResult(parsed, { status: "adopted", room_id: room.room_id, declaration: file, canonical_path: rekeyed.canonical_path },
    () => `Adopted room ${room.room_id} at ${directory}${rekeyed.canonical_path !== directory ? ` (keyed as ${rekeyed.canonical_path})` : ""}. Commit ${file} to share it.`);
}

// Removes the declaration and deletes the room it keyed, with its events and
// notes, so later joins really do resolve to the parent. That matches the
// existing lifecycle, where the last agent leaving deletes a room. Refuses
// while any agent is still in the room.
function removeRoom(runtime: Runtime, parsed: ParsedCommand, target: string | undefined): void {
  const resolved = resolveContextPath(target ?? process.cwd());
  const declaration = resolved.declaration;
  if (!declaration) throw new Error(`No room declaration covers ${resolved.canonical_context_path}.`);
  const room = runtime.commands.listRooms({}).rooms.find((candidate) =>
    candidate.canonical_path === resolved.room_path || candidate.canonical_path === declaration.directory);
  const retired = room ? runtime.commands.retireUnoccupiedRoom({ room_id: room.room_id }).retired : false;
  const file = declarationFile(declaration.directory);
  fs.rmSync(file);
  try { fs.rmdirSync(path.dirname(file)); } catch { /* .talking-stick holds other files */ }
  printResult(parsed, { status: "removed", declaration: file, retired_room_id: retired ? room?.room_id ?? null : null },
    () => `Removed ${file}${retired ? ` and deleted room ${room?.room_id} with its events and notes (any chat console on it is detached)` : ""}. New joins use the parent room.`);
}
