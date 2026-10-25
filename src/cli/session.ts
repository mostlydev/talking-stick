import {
  findCliSessionByRoom,
  findCliSessionForContextPath,
  resolveCliSessionPath,
  removeCliSession,
  insertCliSessionIfAbsent,
  readCliSessions,
  recordRecoveredCliSession,
  upsertJoinedCliSession,
  type CliSession,
  type DerivedIdentity,
  type JoinRecovery,
  type PathRoom
} from "../index.js";
import { resolveContextPath } from "../path-resolution.js";
import { getStringOption, type ParsedCommand } from "./parser.js";
import type { Runtime } from "./runtime.js";
import { selectedRoom } from "./room-selector.js";

export function resolveSessionForReads(
  runtime: Runtime,
  parsed: ParsedCommand,
  identity: DerivedIdentity
): CliSession {
  const explicit = selectedRoom(runtime, parsed);
  if (explicit) return sessionForRoom(identity, explicit);
  const contextPath = parsed.positionals[0] ?? process.cwd();
  const resolvedPath = resolveContextPath(contextPath);
  const sessionPath = resolveCliSessionPath();
  const existing = findLiveSession(runtime, sessionPath, identity.agent_id, contextPath);
  if (existing) {
    return existing;
  }
  const rooms = runtime.commands.listRooms({ context_path: contextPath }).rooms;
  const room = pickDeepestRoom(rooms);
  if (!room) {
    throw new Error("No room found for this path. Run `tt join` first.");
  }

  const session = {
    agent_id: identity.agent_id,
    room_id: room.room_id,
    canonical_path: room.canonical_path,
    workspace_root: resolvedPath.workspace_root,
    updated_at: new Date().toISOString()
  };
  const cached = insertCliSessionIfAbsent(sessionPath, session);
  return cached.room_id === session.room_id
    ? cached
    : resolveSessionForReads(runtime, parsed, identity);
}

export function resolveSessionForNotes(
  runtime: Runtime,
  parsed: ParsedCommand,
  identity: DerivedIdentity
): CliSession {
  const explicit = selectedRoom(runtime, parsed);
  if (explicit) return sessionForRoom(identity, explicit);
  const contextPath = getStringOption(parsed, "path") ?? process.cwd();
  const resolvedPath = resolveContextPath(contextPath);
  const sessionPath = resolveCliSessionPath();
  const hadCachedSession = findCliSessionForContextPath(
    sessionPath, identity.agent_id, contextPath
  ) !== null;
  const existing = findLiveSession(runtime, sessionPath, identity.agent_id, contextPath);
  if (existing) {
    return existing;
  }
  const rooms = runtime.commands.listRooms({ context_path: contextPath }).rooms;
  const room = pickDeepestRoom(rooms);
  if (!room) {
    throw new Error(
      "No room found for this path. Run `tt join` first (or pass --path)."
    );
  }

  const session = {
    agent_id: identity.agent_id,
    room_id: room.room_id,
    canonical_path: room.canonical_path,
    workspace_root: resolvedPath.workspace_root,
    updated_at: new Date().toISOString()
  };
  if (hadCachedSession) {
    const cached = insertCliSessionIfAbsent(sessionPath, session);
    return cached.room_id === session.room_id
      ? cached
      : resolveSessionForNotes(runtime, parsed, identity);
  }
  return session;
}

// An explicitly selected room keys its session by room_id, never by path: a
// stale entry for a replaced room at the same path must not be returned.
function sessionForRoom(identity: DerivedIdentity, room: PathRoom): CliSession {
  const sessionPath = resolveCliSessionPath();
  const existing = findCliSessionByRoom(sessionPath, identity.agent_id, room.room_id);
  if (existing) return existing;
  const session = {
    agent_id: identity.agent_id,
    room_id: room.room_id,
    canonical_path: room.canonical_path,
    workspace_root: resolveContextPath(room.canonical_path).workspace_root,
    updated_at: new Date().toISOString()
  };
  upsertJoinedCliSession(sessionPath, session);
  return findCliSessionByRoom(sessionPath, identity.agent_id, room.room_id) ?? session;
}

function findLiveSession(
  runtime: Runtime,
  sessionPath: string,
  agentId: string,
  contextPath: string
): CliSession | null {
  let session = findCliSessionForContextPath(sessionPath, agentId, contextPath);
  while (session) {
    // Snapshot rooms after reading this candidate so a concurrent join cannot
    // make a new cached room look deleted against an older room snapshot.
    const rooms = runtime.commands.listRooms({ context_path: contextPath }).rooms;
    const roomId = session.room_id;
    if (rooms.some((room) => room.room_id === roomId)) {
      return session;
    }
    // Remove only this deleted room; a live ancestor may still carry a lease.
    removeCliSession(sessionPath, agentId, session.room_id);
    session = findCliSessionForContextPath(sessionPath, agentId, contextPath);
  }
  return session;
}

export function requireLeaseSession(
  identity: DerivedIdentity,
  contextPath: string,
  roomId?: string
): CliSession {
  const session = roomId
    ? findCliSessionByRoom(resolveCliSessionPath(), identity.agent_id, roomId)
    : findCliSessionForContextPath(resolveCliSessionPath(), identity.agent_id, contextPath);

  if (!session?.lease_id || session.turn_id === null || session.turn_id === undefined) {
    throw new Error("No active lease for this path. Run `tt wait` or `tt takeover` first.");
  }

  return session;
}

export function upsertSessionFromJoin(identity: DerivedIdentity, joined: {
  room_id: string;
  canonical_path: string;
  workspace_root: string;
  cursor_event_seq: number;
  recovered?: JoinRecovery;
  recovery_credential?: string;
}): void {
  const sessionPath = resolveCliSessionPath();
  const existing = findCliSessionByRoom(
    sessionPath,
    identity.agent_id,
    joined.room_id
  );
  upsertJoinedCliSession(resolveCliSessionPath(), {
    agent_id: identity.agent_id,
    room_id: joined.room_id,
    canonical_path: joined.canonical_path,
    workspace_root: joined.workspace_root,
    event_cursor_seq: existing?.event_cursor_seq ?? joined.cursor_event_seq,
    ...(joined.recovery_credential ? { recovery_credential: joined.recovery_credential } : {}),
    updated_at: new Date().toISOString()
  });
  // A surviving cache already knows what this session read. Without one,
  // reading resumes where the loss left it. Native deliveries it never
  // consumed come back with their batches either way.
  if (joined.recovered) {
    recordRecoveredCliSession(sessionPath, identity.agent_id, joined.room_id,
      existing?.event_cursor_seq ?? joined.recovered.replay_from_event_seq);
  }
}

/** This agent's recovery credentials from earlier joins, by room. */
export function cachedRecoveryCredentials(identity: DerivedIdentity): Record<string, string> {
  return Object.fromEntries(readCliSessions(resolveCliSessionPath())
    .filter((session) => session.agent_id === identity.agent_id && session.recovery_credential)
    .map((session) => [session.room_id, session.recovery_credential!]));
}

// listRooms for a context path returns rooms in resolution order, most
// specific first. Path length is not specificity once a linked worktree's
// candidates include rooms keyed under the main checkout.
export function pickDeepestRoom(rooms: PathRoom[]): PathRoom | null {
  return rooms[0] ?? null;
}
