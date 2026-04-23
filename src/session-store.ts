import fs from "node:fs";
import path from "node:path";
import { resolveDataDir } from "./config.js";
import { ancestorPaths, resolveContextPath } from "./path-resolution.js";

export interface CliSession {
  agent_id: string;
  room_id: string;
  canonical_path: string;
  workspace_root: string;
  lease_id?: string | null;
  turn_id?: number | null;
  guardian_pid?: number | null;
  guardian_process_started_at?: string | null;
  updated_at: string;
}

export interface ResolveCliSessionPathOptions {
  dataDir?: string;
}

export function resolveCliSessionPath(
  options: ResolveCliSessionPathOptions = {}
): string {
  const dataDir = options.dataDir
    ? path.resolve(options.dataDir)
    : resolveDataDir();
  return path.join(dataDir, "cli-sessions.json");
}

export function readCliSessions(sessionPath: string): CliSession[] {
  try {
    const raw = fs.readFileSync(sessionPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CliSession[]) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export function writeCliSessions(
  sessionPath: string,
  sessions: CliSession[]
): void {
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, `${JSON.stringify(sessions, null, 2)}\n`);
}

export function upsertCliSession(
  sessionPath: string,
  session: CliSession
): void {
  const sessions = readCliSessions(sessionPath);
  const index = sessions.findIndex(
    (candidate) =>
      candidate.agent_id === session.agent_id &&
      candidate.room_id === session.room_id
  );

  if (index === -1) {
    sessions.push(session);
  } else {
    sessions[index] = session;
  }

  writeCliSessions(sessionPath, sessions);
}

export function findCliSessionByRoom(
  sessionPath: string,
  agentId: string,
  roomId: string
): CliSession | null {
  return (
    readCliSessions(sessionPath).find(
      (session) =>
        session.agent_id === agentId && session.room_id === roomId
    ) ?? null
  );
}

export function clearCliSessionLease(
  sessionPath: string,
  agentId: string,
  roomId: string
): void {
  const session = findCliSessionByRoom(sessionPath, agentId, roomId);
  if (!session) {
    return;
  }

  upsertCliSession(sessionPath, {
    ...session,
    lease_id: null,
    turn_id: null,
    guardian_pid: null,
    guardian_process_started_at: null,
    updated_at: new Date().toISOString()
  });
}

export function findCliSessionForContextPath(
  sessionPath: string,
  agentId: string,
  contextPath: string
): CliSession | null {
  const resolved = resolveContextPath(contextPath);
  const candidates = readCliSessions(sessionPath).filter(
    (session) =>
      session.agent_id === agentId &&
      session.workspace_root === resolved.workspace_root
  );

  if (candidates.length === 0) {
    return null;
  }

  const byPath = new Map<string, CliSession[]>();
  for (const session of candidates) {
    const sessionsForPath = byPath.get(session.canonical_path) ?? [];
    sessionsForPath.push(session);
    byPath.set(session.canonical_path, sessionsForPath);
  }

  for (const candidatePath of ancestorPaths(
    resolved.canonical_context_path,
    resolved.workspace_root
  )) {
    const matches = byPath.get(candidatePath);
    if (!matches || matches.length === 0) {
      continue;
    }

    return matches
      .slice()
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0];
  }

  return null;
}
