import fs from "node:fs";
import path from "node:path";
import type { TalkingStickCommands } from "../commands.js";
import type { SupervisorDaemonStatus, SupervisorSnapshot, SupervisorWorkerStatus } from "../supervisor/snapshot.js";
import type { GenerationState, HoldReason } from "../supervisor/state.js";
import { formatDuration, type BusyMemberInfo } from "./chat-format.js";
import type { NavigatorRoom } from "./room-navigator.js";

// What chat shows of the supervisor's headless workers: where each one works,
// its state, and the command that unblocks it. Read-only: chat never starts,
// resumes or restarts a worker.

/** Holds the operator clears with resume, per docs/supervisor.md. */
const RESUME_HOLDS: ReadonlySet<HoldReason> = new Set(["auth_required", "wrong_auth_mode", "deny_undelivered", "crash_loop", "executable_ready"]);
/** Holds that need a new conversation. */
const FRESH_HOLDS: ReadonlySet<HoldReason> = new Set(["resume_failed", "bootstrap_failed"]);

const GENERATION_LABELS: Record<GenerationState, string> = {
  starting: "starting",
  idle: "ready",
  busy: "working",
  awaiting_approval: "denying a prompt",
  awaiting_input: "waiting for input",
  disconnected: "disconnected",
  unknown: "state unknown",
  auth_required: "waiting for login",
  wrong_auth_mode: "wrong login",
  dead: "exited"
};

export interface HeadlessWorker {
  worker_id: string;
  harness: string;
  /** The room it joined, else the room a join from its exact cwd would use: the room's keyed identity. */
  room_path: string;
  /**
   * Where to open that room from: the worker's exact cwd. A keyed room path can
   * name the main checkout, where a worktree-only directory doesn't exist.
   */
  open_path: string;
  /** That room's id when it is open. */
  room_id: string | null;
  /** The member its live process joined as, or null when it hasn't joined. */
  agent_id: string | null;
  state: string;
  held: HoldReason | null;
  /** The operator has to act: held, signed out, or its supervisor isn't running. */
  blocked: boolean;
  /** The command, or step, that unblocks it. */
  remedy: string | null;
  start_error?: string;
  unrestricted?: boolean;
  busy_since: string | null;
  queued_inputs: number;
  denied_requests: number;
  uncertain_inputs: number;
}

export interface HeadlessView {
  workers: HeadlessWorker[];
  /** A supervisor-wide condition that hides worker state. */
  notice: string | null;
}

export interface HeadlessLookups {
  membersForSession(harness: string, harnessSessionId: string): ReadonlyArray<{
    room_id: string; agent_id: string; canonical_path: string;
    harness_pid: number | null; harness_process_started_at: string | null;
  }>;
  /** Whether that member's process is still present in its room. */
  memberAlive(roomId: string, agentId: string): boolean;
  /** The room a join from this exact directory would use; throws when it can't be resolved. */
  roomForPath(cwd: string): { room_path: string; room_id: string | null };
}

export const EMPTY_HEADLESS_VIEW: HeadlessView = { workers: [], notice: null };

/**
 * Lookups against the room database, all read-only. A worker's resolved room
 * is reused until `routeTtlMs` passes, so chat doesn't resolve paths on every refresh.
 */
export function createHeadlessLookups(commands: TalkingStickCommands, routeTtlMs: number, now = () => Date.now()): HeadlessLookups {
  const routes = new Map<string, { at: number; room: { room_path: string; room_id: string | null } }>();
  return {
    membersForSession: (harness, session) => commands.findMembersForSession({ harness_name: harness, harness_session_id: session }),
    // Only a process the room has seen alive counts; unknown liveness never labels a member headless.
    memberAlive: (room, agent) => commands.getRoomState({ room_id: room }).members.some((member) =>
      member.agent_id === agent && member.process_liveness === "alive"),
    roomForPath: (cwd) => {
      const cached = routes.get(cwd);
      if (cached && now() - cached.at < routeTtlMs) return cached.room;
      const peek = commands.peekRoomForPath({ context_path: cwd });
      const room = { room_path: peek.room_path, room_id: peek.room?.room_id ?? null };
      routes.set(cwd, { at: now(), room });
      return room;
    }
  };
}

/**
 * /rooms rows for headless workers whose room isn't open. Each opens from a
 * worker directory that still exists and resolves to that room.
 */
export function unopenedHeadlessRooms(openPaths: ReadonlySet<string>, view: HeadlessView): NavigatorRoom[] {
  const waiting = new Map<string, HeadlessWorker[]>();
  for (const worker of view.workers) {
    if (worker.room_id || openPaths.has(worker.room_path)) continue;
    waiting.set(worker.room_path, [...(waiting.get(worker.room_path) ?? []), worker]);
  }
  return [...waiting].map(([roomPath, workers]) => ({
    id: "", path: roomPath, name: path.basename(roomPath) || roomPath, agents: 0, consoles: 0, active: true,
    last_activity_at: "", unread: 0, open: false,
    open_path: workers.map((worker) => worker.open_path).find((dir) => fs.existsSync(dir)) ?? roomPath,
    ...headlessCounts(workers)
  }));
}

export function holdRemedy(workerId: string, reason: HoldReason): string {
  if (RESUME_HOLDS.has(reason)) return `tt supervisor resume ${workerId}`;
  if (FRESH_HOLDS.has(reason)) return `tt supervisor restart ${workerId} --fresh`;
  return "tt supervisor status";
}

export function workerState(worker: SupervisorWorkerStatus, daemon: SupervisorDaemonStatus):
  Pick<HeadlessWorker, "state" | "held" | "blocked" | "remedy"> {
  if (worker.hold_reason) {
    return { state: `held: ${worker.hold_reason}`, held: worker.hold_reason, blocked: true,
      remedy: holdRemedy(worker.worker_id, worker.hold_reason) };
  }
  if (worker.desired === "paused") return { state: "paused", held: null, blocked: false, remedy: null };
  if (worker.desired === "stopped") return { state: worker.stop_reason ? `stopped: ${worker.stop_reason.replace(/_/g, " ")}` : "stopped", held: null, blocked: false, remedy: null };
  if (daemon === "stopped") return { state: "supervisor not running", held: null, blocked: true, remedy: "tt supervisor run" };
  if (daemon === "unknown") return { state: "supervisor state unknown", held: null, blocked: false, remedy: "tt supervisor status" };
  const generation = worker.generation;
  if (!generation) return { state: "starting", held: null, blocked: false, remedy: null };
  if (generation.ended_at !== null) {
    return { state: worker.next_start_at ? "restarting" : "exited", held: null, blocked: false, remedy: null };
  }
  const state = GENERATION_LABELS[generation.state] ?? "state unknown";
  // A Codex worker waits for its login and rechecks it; it isn't held.
  if (generation.state === "auth_required") return { state, held: null, blocked: true, remedy: `sign in to ${worker.harness}; it rechecks` };
  if (generation.state === "wrong_auth_mode") return { state, held: null, blocked: true, remedy: `sign in to ${worker.harness} with a subscription` };
  return { state, held: null, blocked: false, remedy: null };
}

/**
 * The member this worker's current process joined as. The session must match
 * and so must the exact process, so a terminal peer reusing a session id is
 * never taken for a headless worker.
 */
function joinedMember(worker: SupervisorWorkerStatus, lookups: HeadlessLookups) {
  const generation = worker.generation;
  const startedAt = worker.generation_process_started_at?.trim();
  if (!generation || generation.ended_at !== null || !generation.session_id || generation.pid === null || !startedAt) return null;
  return lookups.membersForSession(worker.harness, `harness:${generation.session_id}`).find((member) =>
    member.harness_pid === generation.pid && member.harness_process_started_at?.trim() === startedAt &&
    lookups.memberAlive(member.room_id, member.agent_id)) ?? null;
}

export function routeHeadlessWorkers(snapshot: SupervisorSnapshot, lookups: HeadlessLookups): HeadlessView {
  if (snapshot.kind === "none") return EMPTY_HEADLESS_VIEW;
  if (snapshot.kind === "needs_migration") {
    return { workers: [], notice: "Supervisor state must move first: stop the supervisor, then run tt supervisor migrate." };
  }
  if (snapshot.kind === "unavailable") {
    return { workers: [], notice: `Supervisor ${snapshot.reason === "state" ? "state" : "database"} is unreadable; see tt supervisor status.` };
  }
  const workers = snapshot.workers.map((worker): HeadlessWorker => {
    let member: ReturnType<typeof joinedMember> = null;
    try { member = joinedMember(worker, lookups); } catch { /* treated as not joined */ }
    let room: { room_path: string; room_id: string | null };
    if (member) room = { room_path: member.canonical_path, room_id: member.room_id };
    else {
      try { room = lookups.roomForPath(worker.cwd); } catch { room = { room_path: worker.cwd, room_id: null }; }
    }
    const stateInfo = workerState(worker, snapshot.daemon);
    const busy = stateInfo.state === "working" || stateInfo.state === "denying a prompt";
    return {
      worker_id: worker.worker_id,
      harness: worker.harness,
      ...room,
      open_path: worker.cwd,
      agent_id: member?.agent_id ?? null,
      ...stateInfo,
      start_error: worker.start_error,
      ...(worker.start_remedy ? { remedy: worker.start_remedy } : {}),
      unrestricted: worker.unrestricted,
      busy_since: busy && worker.generation?.ended_at === null ? worker.generation.last_model_activity_at : null,
      queued_inputs: worker.queued_inputs,
      denied_requests: worker.denied_requests,
      uncertain_inputs: worker.uncertain_inputs
    };
  });
  return { workers, notice: null };
}

/** Workers in a room: by its id when the room is open, else by its path. */
export function workersInRoom(view: HeadlessView, room: { room_id: string | null; room_path: string }): HeadlessWorker[] {
  return view.workers.filter((worker) => room.room_id && worker.room_id
    ? worker.room_id === room.room_id
    : worker.room_path === room.room_path);
}

export function headlessCounts(workers: readonly HeadlessWorker[]): { headless: number; blocked: number } {
  return { headless: workers.length, blocked: workers.filter((worker) => worker.blocked).length };
}

/**
 * Joined headless workers currently mid-turn or holding queued envelopes, keyed
 * by their room agent id so chat replaces "standby" with "working 4m (1 queued)".
 */
export function headlessBusyMembers(workers: readonly HeadlessWorker[]): Map<string, BusyMemberInfo> {
  const result = new Map<string, BusyMemberInfo>();
  for (const worker of workers) {
    if (!worker.agent_id) continue;
    const busy = worker.state === "working" || worker.state === "denying a prompt";
    if (!busy && worker.queued_inputs === 0) continue;
    const existing = result.get(worker.agent_id);
    if (!existing) {
      result.set(worker.agent_id, { busy, since: busy ? worker.busy_since : null, queued: worker.queued_inputs });
      continue;
    }
    const nextBusy = existing.busy || busy;
    const candidateSince = busy ? worker.busy_since : null;
    const nextSince = existing.since && candidateSince
      ? (existing.since < candidateSince ? existing.since : candidateSince)
      : (existing.since ?? candidateSince);
    result.set(worker.agent_id, {
      busy: nextBusy,
      since: nextBusy ? nextSince : null,
      queued: existing.queued + worker.queued_inputs
    });
  }
  return result;
}

/** One /who line per worker, already plain text; the caller sanitizes and paints. */
export function headlessWhoLines(
  workers: readonly HeadlessWorker[],
  nameOf: (agentId: string) => string,
  now?: Date
): string[] {
  return workers.map((worker) => {
    const stateLabel = now && worker.busy_since && (worker.state === "working" || worker.state === "denying a prompt")
      ? `${worker.state} ${formatDuration(now, worker.busy_since)}`
      : worker.state;
    const where = worker.agent_id ? `joined as ${nameOf(worker.agent_id)}` : "not joined";
    const extras = [
      worker.unrestricted ? "unrestricted" : "",
      worker.start_error ?? "",
      worker.queued_inputs ? `${worker.queued_inputs} queued` : "",
      worker.denied_requests ? `${worker.denied_requests} denied (tt supervisor approvals)` : "",
      worker.uncertain_inputs ? `${worker.uncertain_inputs} uncertain` : ""
    ].filter(Boolean);
    return [`${worker.worker_id} (${worker.harness})`, stateLabel, where, ...extras].join(" · ") +
      (worker.remedy ? ` → ${worker.remedy}` : "");
  });
}

/** A short header marker, longest form first; empty when nothing needs the operator. */
export function headlessMarker(here: number, elsewhere: number): string[] {
  if (!here && !elsewhere) return [];
  if (here && elsewhere) return [`${here} headless blocked · /who · ${elsewhere} in other rooms`, `${here + elsewhere} blocked`];
  if (here) return [`${here} headless blocked · /who`, `${here} blocked`];
  return [`${elsewhere} headless blocked in other rooms · /rooms`, `${elsewhere} blocked`];
}

/** Lines to print when workers in this room become blocked or stop being blocked. */
export function headlessTransitions(previous: ReadonlyMap<string, HeadlessWorker> | null, current: readonly HeadlessWorker[]): string[] {
  if (!previous) return [];
  const lines: string[] = [];
  for (const worker of current) {
    const before = previous.get(worker.worker_id);
    if (worker.blocked && (!before?.blocked || before.state !== worker.state)) {
      lines.push(`Headless ${worker.worker_id} is blocked: ${worker.state}. /who shows the fix.`);
    } else if (!worker.blocked && before?.blocked) {
      lines.push(`Headless ${worker.worker_id} is no longer blocked: ${worker.state}.`);
    }
  }
  return lines;
}
