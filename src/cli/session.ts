import {
  findCliSessionForContextPath,
  resolveCliSessionPath,
  upsertCliSession,
  upsertJoinedCliSession,
  type CliSession,
  type DerivedIdentity,
  type PathRoom
} from "../index.js";
import { resolveContextPath } from "../path-resolution.js";
import { getStringOption, type ParsedCommand } from "./parser.js";
import type { Runtime } from "./runtime.js";

export function resolveSessionForReads(
  runtime: Runtime,
  parsed: ParsedCommand,
  identity: DerivedIdentity
): CliSession {
  const contextPath = parsed.positionals[0] ?? process.cwd();
  const resolvedPath = resolveContextPath(contextPath);
  const sessionPath = resolveCliSessionPath();
  const existing = findCliSessionForContextPath(
    sessionPath,
    identity.agent_id,
    contextPath
  );
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
  upsertCliSession(sessionPath, session);
  return session;
}

export function resolveSessionForNotes(
  runtime: Runtime,
  parsed: ParsedCommand,
  identity: DerivedIdentity
): CliSession {
  const contextPath = getStringOption(parsed, "path") ?? process.cwd();
  const resolvedPath = resolveContextPath(contextPath);
  const sessionPath = resolveCliSessionPath();
  const existing = findCliSessionForContextPath(
    sessionPath,
    identity.agent_id,
    contextPath
  );
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
  upsertCliSession(sessionPath, session);
  return session;
}

export function requireLeaseSession(
  identity: DerivedIdentity,
  contextPath: string
): CliSession {
  const session = findCliSessionForContextPath(
    resolveCliSessionPath(),
    identity.agent_id,
    contextPath
  );

  if (!session?.lease_id || session.turn_id === null || session.turn_id === undefined) {
    throw new Error("No active lease for this path. Run `tt wait` or `tt takeover` first.");
  }

  return session;
}

export function upsertSessionFromJoin(identity: DerivedIdentity, joined: {
  room_id: string;
  canonical_path: string;
  workspace_root: string;
}): void {
  upsertJoinedCliSession(resolveCliSessionPath(), {
    agent_id: identity.agent_id,
    room_id: joined.room_id,
    canonical_path: joined.canonical_path,
    workspace_root: joined.workspace_root,
    updated_at: new Date().toISOString()
  });
}

export function pickDeepestRoom(rooms: PathRoom[]): PathRoom | null {
  if (rooms.length === 0) {
    return null;
  }

  return rooms
    .slice()
    .sort((left, right) => right.canonical_path.length - left.canonical_path.length)[0];
}
