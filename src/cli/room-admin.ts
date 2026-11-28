import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOM_DECLARATION_FILE, insideNestedRepository, isWithinOrSame, readDeclaration, resolveContextPath } from "../path-resolution.js";
import { HUMAN_CHAT_SESSION_KIND } from "../types.js";
import type { LostMember, PathRoom, RoomActivity, RoomBlocker, RoomBlockerEvent, RoomGoal, RoomGoalEvent, RoomMember, RoomOverseerSummary } from "../types.js";
import { describeLossCause, describeLossCauseShort, isDormant } from "../lost-member.js";
import { formatRelativeTime, printResult } from "./output.js";
import { getStringOption, hasOption, parseOptionalInteger, type ParsedCommand } from "./parser.js";
import { resolveRoomSelector, roomShortName, selectedRoom } from "./room-selector.js";
import type { Runtime } from "./runtime.js";
import { deriveCliIdentity } from "./identity.js";
import { readAllStdin } from "./handoff.js";
import { askRoom, readReplies } from "./visitor-commands.js";
import { sanitizeChatText } from "./chat-format.js";

// `tt room create|list|adopt|remove`. Declarations are files in the checkout;
// the database row for a declared room appears on its first join.
export function handleRoomCommand(runtime: Runtime, parsed: ParsedCommand): void | Promise<void> {
  const [action, target, ...rest] = parsed.positionals;
  switch (action) {
    case "ask":
      if (hasOption(parsed, "resolves")) throw new Error("Use tt room send <room> --resolves <id> to answer a blocker.");
      if (!target) throw new Error("Usage: tt room ask <room> --to <agent[,agent]|room> <body...> [--stdin] [--request-key KEY]");
      return askRoom(runtime, parsed, briefTarget(runtime, parsed, target), rest);
    case "replies": return readReplies(runtime, parsed, target);
    case "send": return sendResolution(runtime, parsed, target, rest);
    case "create": return createRoom(runtime, parsed, target);
    case "ensure": return ensureRoom(runtime, parsed, target);
    case "list": return hasOption(parsed, "all") ? listHostRooms(runtime, parsed) : listRooms(runtime, parsed, target);
    case "brief": return briefRoom(runtime, parsed, target);
    case "adopt": return adoptRoom(runtime, parsed, target);
    case "remove": return removeRoom(runtime, parsed, target);
    default:
      throw new Error("Usage: tt room create [path] [--name NAME] | ensure <path> [--name NAME] | list [path] [--all] | brief [room] [--limit N] [--before SEQ] | ask <room> --to <agents|room> <body> | send <room> --resolves <id> <body> | replies <request-id> [--timeout S] | adopt [path] | remove [path]");
  }
}

async function readRoomText(parsed: ParsedCommand, parts: string[]): Promise<string> {
  return parts.length ? parts.join(" ") : hasOption(parsed, "stdin") ? readAllStdin() : "";
}

async function sendResolution(runtime: Runtime, parsed: ParsedCommand, target: string | undefined, rest: string[]): Promise<void> {
  const resolves = getStringOption(parsed, "resolves");
  if (!target || !resolves) throw new Error("Usage: tt room send <room> --resolves <id> <text...> [--stdin]");
  const room = briefTarget(runtime, parsed, target);
  const result = await runtime.commands.sendMessageAndWake(deriveCliIdentity(parsed), {
    room_id: room.room_id, body: await readRoomText(parsed, rest), resolves
  });
  printResult(parsed, result, () => `${result.deduplicated ? "Already resolved" : "Resolved"} ${result.resolves} in message #${result.event_seq}.`);
}

export const OVERSEER_USAGE = [
  "tt overseer register <alias> | unregister <alias>",
  "tt overseer set <alias> [--in ROOM] | show [--in ROOM] | clear [--in ROOM]"
].join("\n");

function formatOverseer(inbox: RoomOverseerSummary | null): string {
  if (!inbox) return "No overseer designated.";
  const process = inbox.reachable ? "process live" : "process unverified";
  return `Overseer ${inbox.alias} (${sanitizeChatText(inbox.agent_id)}, ${process}, ${inbox.transport}) · ${inbox.pending} pending · ${inbox.unconfirmed} unconfirmed · ${inbox.failed} failed`;
}

export function handleOverseerCommand(runtime: Runtime, parsed: ParsedCommand): void {
  const [action, alias, ...rest] = parsed.positionals;
  if (rest.length || !action || !["register", "unregister", "set", "show", "clear"].includes(action)) throw new Error(OVERSEER_USAGE);
  if (Boolean(alias) !== (action === "register" || action === "unregister" || action === "set")) throw new Error(OVERSEER_USAGE);
  const identity = deriveCliIdentity(parsed);
  if (action === "register") {
    if (hasOption(parsed, "in")) throw new Error("Register the inbox outside the room. Use overseer set to designate it for a room.");
    const inbox = runtime.commands.registerOverseer(identity, alias);
    printResult(parsed, inbox, () => `Registered overseer inbox ${inbox.alias} via ${inbox.transport}.`);
    return;
  }
  if (action === "unregister") {
    if (hasOption(parsed, "in")) throw new Error("Use overseer clear to remove one room's designation.");
    const unregistered = runtime.commands.unregisterOverseer(identity, alias);
    printResult(parsed, { unregistered }, () => unregistered ? "Overseer inbox unregistered." : "No such overseer inbox.");
    return;
  }
  if (hasOption(parsed, "in") && !getStringOption(parsed, "in")) throw new Error("--in needs a room.");
  const room = briefTarget(runtime, parsed, undefined);
  const inbox = action === "show" ? runtime.commands.getRoomOverseer(room.room_id)
    : runtime.commands.setRoomOverseer(identity, { room_id: room.room_id, alias: action === "clear" ? null : alias });
  printResult(parsed, { room_id: room.room_id, overseer: inbox }, () => formatOverseer(inbox));
}

export const GOAL_USAGE = [
  "tt goal add <brief> --done-when CRITERION [--in ROOM] [--stdin]",
  "tt goal list [--all] [--in ROOM] | goal show <id> [--in ROOM]",
  "tt goal close <id> <done|failed|withdrawn> <evidence or reason> [--in ROOM] [--stdin]"
].join("\n");

function formatGoal(goal: RoomGoal, detail: boolean): string {
  const summary = `${goal.goal_id} (${goal.status})  ${sanitizeChatText(detail ? goal.brief : excerpt(goal.brief))}`;
  if (!detail) return summary;
  return [summary, `Done when ${sanitizeChatText(goal.completion_criterion)}`,
    `Opened ${goal.created_at} by ${sanitizeChatText(goal.created_by)}`,
    ...(goal.closed_at ? [`Closed ${goal.closed_at} by ${sanitizeChatText(goal.closed_by ?? "")} · #${goal.closure_event_seq}`,
      sanitizeChatText(goal.evidence ?? "")] : [])].join("\n");
}

export async function handleGoalCommand(runtime: Runtime, parsed: ParsedCommand): Promise<void> {
  const [action, ...args] = parsed.positionals;
  if (!action || !["add", "list", "show", "close"].includes(action)) throw new Error(GOAL_USAGE);
  if (hasOption(parsed, "in") && !getStringOption(parsed, "in")) throw new Error("--in needs a room.");
  const roomId = briefTarget(runtime, parsed, undefined).room_id;
  if (action === "list") {
    if (args.length) throw new Error(GOAL_USAGE);
    const goals = runtime.commands.listGoals({ room_id: roomId, all: hasOption(parsed, "all") });
    printResult(parsed, { room_id: roomId, goals }, () => goals.length ? goals.map(goal => formatGoal(goal, false)).join("\n") : "No goals.");
    return;
  }
  if (action === "show") {
    if (args.length !== 1) throw new Error(GOAL_USAGE);
    const goal = runtime.commands.getGoal({ room_id: roomId, goal_id: args[0] });
    printResult(parsed, goal, () => formatGoal(goal, true));
    return;
  }
  const identity = deriveCliIdentity(parsed);
  if (action === "add") {
    const criterion = getStringOption(parsed, "done-when");
    if (!criterion?.trim()) throw new Error("State the completion criterion with --done-when.");
    const goal = runtime.commands.addGoal(identity, { room_id: roomId, brief: await readRoomText(parsed, args), completion_criterion: criterion });
    printResult(parsed, goal, () => formatGoal(goal, true));
    return;
  }
  const [goalId, status, ...rest] = args;
  if (!goalId || (status !== "done" && status !== "failed" && status !== "withdrawn")) throw new Error(GOAL_USAGE);
  const goal = runtime.commands.closeGoal(identity, { room_id: roomId, goal_id: goalId, status,
    evidence: await readRoomText(parsed, rest) });
  printResult(parsed, goal, () => formatGoal(goal, true));
}

function formatBlocker(blocker: RoomBlocker): string {
  let status = "open";
  if (blocker.resolution_event_seq !== null) status = `resolved in #${blocker.resolution_event_seq}`;
  else if (blocker.closed_at) status = "withdrawn";
  return `${blocker.blocker_id}${blocker.goal_id ? ` → ${blocker.goal_id}` : ""} (${status})  ${sanitizeChatText(blocker.body)}`;
}

export async function handleLiaisonCommand(runtime: Runtime, parsed: ParsedCommand): Promise<void> {
  const [action, target] = parsed.positionals;
  const room = briefTarget(runtime, parsed, undefined);
  const identity = deriveCliIdentity(parsed);
  if (action === "set" && target) {
    const result = runtime.commands.setLiaison(identity, { room_id: room.room_id, liaison_agent_id: target });
    printResult(parsed, result, () => `Liaison is ${result.liaison_agent_id}.`);
    return;
  }
  if (action === "clear" && !target) {
    const result = runtime.commands.setLiaison(identity, { room_id: room.room_id, liaison_agent_id: null });
    printResult(parsed, result, () => "Liaison cleared. The room picks one from its live members.");
    return;
  }
  throw new Error("Usage: tt liaison set <agent> | clear [--in ROOM]");
}

export async function handleBlockerCommand(runtime: Runtime, parsed: ParsedCommand): Promise<void> {
  const [action, ...rest] = parsed.positionals;
  const room = briefTarget(runtime, parsed, undefined);
  if (action === "list") {
    const blockers = runtime.commands.listBlockers({ room_id: room.room_id, all: hasOption(parsed, "all") });
    printResult(parsed, { room_id: room.room_id, blockers }, () => blockers.length
      ? blockers.map(formatBlocker).join("\n")
      : "No blockers.");
    return;
  }
  const identity = deriveCliIdentity(parsed);
  if (action === "add") {
    const goalId = getStringOption(parsed, "goal");
    if (hasOption(parsed, "goal") && !goalId) throw new Error("--goal needs an ID such as G1.");
    const blocker = runtime.commands.addBlocker(identity, {
      room_id: room.room_id, body: await readRoomText(parsed, rest), goal_id: goalId
    });
    printResult(parsed, blocker, () => `Open blocker ${blocker.blocker_id}.`);
    return;
  }
  if (action === "withdraw" && rest[0]) {
    const blocker = runtime.commands.withdrawBlocker(identity, {
      room_id: room.room_id, blocker_id: rest[0], reason: await readRoomText(parsed, rest.slice(1))
    });
    printResult(parsed, blocker, () => `Withdrawn ${blocker.blocker_id}.`);
    return;
  }
  throw new Error("Usage: tt blocker add <facts and question> [--goal G<N>] | list [--all] | withdraw <id> <reason> [--in ROOM] [--stdin]");
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
  fs.writeFileSync(staged, `# Talking Stick room boundary. Commit this file to share the layout.\n${name ? `name = "${name}"\n` : ""}id = "${randomUUID()}"\n`);
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
  // Content tt does not understand still declares the room, as for a join, so
  // it is only a warning. A declaration tt cannot read is an error: ensure
  // must not certify a room it cannot vouch for.
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`${file} is not a file.`);
  try {
    fs.accessSync(file, fs.constants.R_OK);
  } catch (error) {
    throw new Error(`${file} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const declared = readDeclaration(file);
  if (name !== undefined && declared.name !== name) {
    throw new Error(`${file} already declares ${declared.name ? `the room name ${JSON.stringify(declared.name)}` : "a room without a name"}, not ${JSON.stringify(name)}.`);
  }
  const resolved = resolveContextPath(directory);
  if (resolved.declaration?.directory !== directory) {
    throw new Error(`${file} does not declare a room for ${directory}.`);
  }
  const room = runtime.commands.openRoom({ context_path: directory });
  // room_path is the room's identity, keyed by the main checkout inside a
  // linked worktree; pin is the declared directory, which reopens the room.
  const result = { status, room_id: room.room_id, room_path: room.canonical_path, pin: directory, rel_path: resolved.declaration.rel_path,
    name: resolved.declaration.name ?? path.basename(directory), declaration: file,
    ...(declared.problem ? { warning: declared.problem } : {}) };
  printResult(parsed, result, () => [
    `${status === "created" ? "Declared" : "Found"} room ${result.name} at ${directory}.`,
    ...(declared.problem ? [`Warning: ${declared.problem}`] : []),
    `Pin agents to it with TT_ROOM=${result.pin}; it reopens on join after it empties.`
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

type ListedLostMember = Pick<LostMember, "agent_id" | "harness_name" | "process_kind" | "process_liveness" | "hook_reason" | "lost_at"> &
  { state: "dormant" | "lost"; cause: string };

/** A dormant or lost member as listings show it: still in the room's records, and able to rejoin. */
function listedLostMember(lost: LostMember): ListedLostMember {
  return { agent_id: lost.agent_id, harness_name: lost.harness_name, process_kind: lost.process_kind,
    process_liveness: lost.process_liveness, hook_reason: lost.hook_reason, lost_at: lost.lost_at,
    state: isDormant(lost) ? "dormant" : "lost", cause: describeLossCause(lost) };
}

/** One line for dormant members and one for lost ones, each only when it has any. */
function formatLostMembers(lost: readonly ListedLostMember[]): string[] {
  const list = (state: ListedLostMember["state"]) => lost.filter((member) => member.state === state)
    .map((member) => `${member.agent_id} (${formatRelativeTime(member.lost_at)}: ${describeLossCauseShort(member)})`).join(", ");
  return [["dormant", list("dormant")], ["lost, recoverable", list("lost")]]
    .filter(([, members]) => members).map(([label, members]) => `${label}: ${members}`);
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
  const counts = new Map(runtime.commands.getBlockerCounts().map(row => [row.room_id, row.count]));
  const goalCounts = new Map(runtime.commands.getGoalCounts().map(row => [row.room_id, row.count]));
  const rooms = runtime.commands.listRooms({}).rooms
    .filter((room) => room.state !== "closed")
    .map((room) => {
      const members = liveMembers(runtime, room.room_id);
      const lost = runtime.commands.getRoomState({ room_id: room.room_id }).lost_members ?? [];
      const activity = runtime.commands.getRoomActivity({ room_id: room.room_id });
      const handoff = activity.last_handoff;
      return {
        name: roomShortName(room),
        room_id: room.room_id,
        canonical_path: room.canonical_path,
        state: room.state,
        owner: room.owner,
        open_blockers: counts.get(room.room_id) ?? 0,
        open_goals: goalCounts.get(room.room_id) ?? 0,
        overseer: runtime.commands.getRoomOverseer(room.room_id),
        agents: members.filter((member) => member.session_kind !== HUMAN_CHAT_SESSION_KIND).map((member) => member.agent_id),
        consoles: members.filter((member) => member.session_kind === HUMAN_CHAT_SESSION_KIND).map((member) => member.agent_id),
        lost_members: lost.map(listedLostMember),
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
    .filter((room) => room.agents.length > 0 || room.consoles.length > 0 || room.lost_members.length > 0 || room.open_blockers > 0 || room.open_goals > 0)
    .sort((left, right) => right.last_activity_at.localeCompare(left.last_activity_at));
  printResult(parsed, { rooms }, () => rooms.length === 0
    ? "No rooms on this host have live or lost members, open goals, or open blockers."
    : rooms.map((room) => {
      const who = [room.agents.join(", ") || "no agents", room.consoles.length > 0 ? `${room.consoles.length} console${room.consoles.length === 1 ? "" : "s"}` : null]
        .filter(Boolean).join(", ");
      const lines = [`#${room.name}  ${who}${room.owner ? `  stick=${room.owner}${room.state === "stale_owner" ? " (stale)" : ""}` : ""}  active ${formatRelativeTime(room.last_activity_at)}`,
        `  ${room.canonical_path}  ${room.room_id}`];
      lines.push(...formatLostMembers(room.lost_members).map((line) => `  ${line}`));
      if (room.overseer) lines.push(`  ${formatOverseer(room.overseer)}`);
      if (room.open_goals) lines.push(`  ${room.open_goals} open goal${room.open_goals === 1 ? "" : "s"}`);
      if (room.open_blockers) lines.push(`  ${room.open_blockers} open blocker${room.open_blockers === 1 ? "" : "s"}`);
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
const BRIEF_GOALS = 10;
const BRIEF_EVENT_TYPES = ["message_sent", "release", "pass", "takeover", "goal_added", "goal_closed", "blocker_added", "blocker_withdrawn"] as const;

function clip(text: string, limit: number): { text: string; truncated: boolean } {
  return text.length > limit ? { text: `${text.slice(0, limit - 1)}…`, truncated: true } : { text, truncated: false };
}

// Explicit path syntax names a directory; anything else is a room selector,
// so `tt room brief api` never depends on what the caller's cwd contains.
function isPathSyntax(target: string): boolean {
  return target === "." || target === ".." || path.isAbsolute(target) || /^\.\.?[\\/]/.test(target);
}

// The named room, the --in/TT_ROOM room, or the caller's directory's room.
export function briefTarget(runtime: Runtime, parsed: ParsedCommand, target: string | undefined): PathRoom {
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
    const goal = event.goal;
    const goalClip = goal?.status === "open"
      ? [clip(goal.brief, BRIEF_BODY_CHARS), clip(goal.completion_criterion, BRIEF_BODY_CHARS)]
      : goal ? [clip(goal.evidence, BRIEF_BODY_CHARS)] : [];
    const clippedGoal: RoomGoalEvent | undefined = goal?.status === "open"
      ? { ...goal, brief: goalClip[0].text, completion_criterion: goalClip[1].text }
      : goal ? { ...goal, evidence: goalClip[0].text } : undefined;
    const blocker = event.blocker;
    const blockerClip = blocker ? clip(blocker.status === "open" ? blocker.body : blocker.reason, BRIEF_BODY_CHARS) : undefined;
    const clippedBlocker = blocker?.status === "open" ? { ...blocker, body: blockerClip!.text }
      : blocker ? { ...blocker, reason: blockerClip!.text } : undefined;
    const truncated = blockerClip?.truncated || body?.truncated || handoff?.status.truncated || handoff?.next_action.truncated || goalClip.some(part => part.truncated);
    return {
      event_seq: event.event_seq,
      event_type: event.event_type,
      from_agent_id: event.from_agent_id,
      to: event.to_agent_id ?? event.payload?.recipients ?? null,
      created_at: event.created_at,
      ...(body ? { body: body.text } : {}),
      ...(clippedGoal ? { goal: clippedGoal } : {}),
      ...(clippedBlocker ? { blocker: clippedBlocker } : {}),
      ...(handoff ? { status: handoff.status.text, next_action: handoff.next_action.text } : {}),
      // A visitor's question, or an answer to one (sent to the visitor, so
      // its to is null like a room message).
      ...(event.payload?.request_id ? { request_id: event.payload.request_id } : {}),
      ...(event.payload?.in_reply_to ? { in_reply_to: event.payload.in_reply_to } : {}),
      ...(event.payload?.resolves ? { resolves: event.payload.resolves } : {}),
      ...(truncated ? { truncated: true, full: readOne(event.event_seq) } : {})
    };
  });
  const oldest = recent[0]?.event_seq;
  const hasOlder = oldest !== undefined && runtime.commands.getRecentRoomEvents({ room_id: room.room_id, limit: 1,
    event_types: eventTypes, before_event_seq: oldest }).length > 0;
  const goals = runtime.commands.listGoals({ room_id: room.room_id, limit: BRIEF_GOALS + 1 });
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
    lost_members: (state.lost_members ?? []).map(listedLostMember),
    last_handoff: activity.last_handoff,
    room_handoff: runtime.commands.roomHandoffPointer(room.room_id),
    notes: notes.notes.map((note) => ({
      note_id: note.note_id, author_agent_id: note.author_agent_id, created_at: note.created_at,
      body: clip(note.body, BRIEF_BODY_CHARS).text
    })),
    notes_total: notes.total,
    overseer: runtime.commands.getRoomOverseer(room.room_id),
    goals: goals.slice(0, BRIEF_GOALS).map(goal => ({ ...goal, brief: clip(goal.brief, BRIEF_BODY_CHARS).text,
      completion_criterion: clip(goal.completion_criterion, BRIEF_BODY_CHARS).text })),
    more_goals: goals.length > BRIEF_GOALS,
    blockers: runtime.commands.listBlockers({ room_id: room.room_id }),
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
  lost_members: ListedLostMember[];
  last_handoff: RoomActivity["last_handoff"];
  room_handoff: ReturnType<Runtime["commands"]["roomHandoffPointer"]>;
  notes: { author_agent_id: string; body: string }[]; notes_total: number;
  overseer: RoomOverseerSummary | null;
  goals: RoomGoal[];
  more_goals: boolean;
  blockers: RoomBlocker[];
  recent: { event_seq: number; event_type: string; from_agent_id: string | null; to: unknown; created_at: string;
    body?: string; goal?: RoomGoalEvent; blocker?: RoomBlockerEvent; status?: string; next_action?: string; full?: string; request_id?: string; in_reply_to?: string; resolves?: string }[];
  older: string | null; updates_since: string;
}): string {
  const lines = [`#${brief.name}  ${brief.canonical_path}  ${brief.room_id}`];
  const stick = brief.owner ? `${brief.owner}${brief.state === "stale_owner" ? " (stale)" : ""}`
    : brief.reserved_for ? `nobody, reserved for ${brief.reserved_for}` : `nobody (${brief.state})`;
  lines.push(`stick: ${stick}`);
  lines.push(`members: ${brief.members.map((member) =>
    `${member.agent_id}${member.kind === "console" ? " (console)" : ""}${memberPresence(member)}`).join(", ") || "none"}`);
  lines.push(...formatLostMembers(brief.lost_members));
  if (brief.overseer) lines.push(formatOverseer(brief.overseer));
  if (brief.room_handoff) lines.push(`Room logbook from ${brief.room_handoff.created_at} · ${brief.room_handoff.story_count} stories · tt handoff show ${brief.room_id}`);
  if (brief.goals.length) lines.push("", "Open goals", ...brief.goals.map(goal =>
    `  ${goal.goal_id} · opened ${formatRelativeTime(goal.created_at)} · ${sanitizeChatText(excerpt(goal.brief))}`));
  if (brief.more_goals) lines.push(`  More goals in tt goal list --in ${brief.room_id}`);
  if (brief.blockers.length) lines.push("", "Open blockers",
    ...brief.blockers.map(blocker => `  ${blocker.blocker_id}${blocker.goal_id ? ` → ${blocker.goal_id}` : ""} (${sanitizeChatText(blocker.author_agent_id)})  ${sanitizeChatText(blocker.body).replace(/\s+/g, " ")}`));
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
      lines.push(`  #${event.event_seq} ${formatRelativeTime(event.created_at)} ${kind}${event.from_agent_id ?? "unknown"} → ${to}${event.request_id ? ` (request ${event.request_id})` : ""}${event.resolves ? ` (resolves ${event.resolves})` : ""}`);
      const goal = event.goal;
      const goalText = goal?.status === "open" ? `${goal.goal_id} · ${goal.brief}\nDone when ${goal.completion_criterion}` :
        goal ? `${goal.goal_id} · ${goal.status} · ${goal.evidence}` : undefined;
      const blocker = event.blocker;
      const blockerText = blocker ? `${blocker.blocker_id} · ${blocker.status} · ${blocker.status === "open" ? blocker.body : blocker.reason}` : undefined;
      const eventText = goalText ?? blockerText;
      const text = event.body ?? (eventText ? sanitizeChatText(eventText) :
        [event.status, event.next_action && `next: ${event.next_action}`].filter(Boolean).join(" "));
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
