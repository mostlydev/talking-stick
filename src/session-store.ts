import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
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
  event_cursor_seq?: number;
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
  withSessionLock(sessionPath, () => writeCliSessionsUnlocked(sessionPath, sessions));
}

function writeCliSessionsUnlocked(
  sessionPath: string,
  sessions: CliSession[]
): void {
  writeFileAtomic(sessionPath, `${JSON.stringify(sessions, null, 2)}\n`);
}

export function upsertCliSession(
  sessionPath: string,
  session: CliSession
): void {
  withSessionLock(sessionPath, () => {
    const sessions = readCliSessions(sessionPath);
    const index = sessions.findIndex(
      (candidate) =>
        candidate.agent_id === session.agent_id &&
        candidate.room_id === session.room_id
    );

    if (index === -1) {
      sessions.push(session);
    } else {
      const existing = sessions[index];
      const merged = { ...existing, ...session };
      if (
        existing.event_cursor_seq !== undefined &&
        session.event_cursor_seq !== undefined
      ) {
        merged.event_cursor_seq = Math.max(
          existing.event_cursor_seq,
          session.event_cursor_seq
        );
      }
      sessions[index] = merged;
    }

    writeCliSessionsUnlocked(sessionPath, sessions);
  });
}

export function upsertJoinedCliSession(
  sessionPath: string,
  session: Pick<
    CliSession,
    | "agent_id"
    | "room_id"
    | "canonical_path"
    | "workspace_root"
    | "event_cursor_seq"
    | "updated_at"
  >
): void {
  upsertCliSession(sessionPath, session);
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
  withSessionLock(sessionPath, () => {
    const sessions = readCliSessions(sessionPath);
    const index = sessions.findIndex(
      (session) => session.agent_id === agentId && session.room_id === roomId
    );
    if (index === -1) return;
    sessions[index] = {
      ...sessions[index],
      lease_id: null,
      turn_id: null,
      guardian_pid: null,
      guardian_process_started_at: null,
      updated_at: new Date().toISOString()
    };
    writeCliSessionsUnlocked(sessionPath, sessions);
  });
}

export function removeCliSession(
  sessionPath: string,
  agentId: string,
  roomId: string
): void {
  withSessionLock(sessionPath, () => {
    const sessions = readCliSessions(sessionPath).filter(
      (session) =>
        !(session.agent_id === agentId && session.room_id === roomId)
    );
    writeCliSessionsUnlocked(sessionPath, sessions);
  });
}

export function removeCliSessionsForRoom(
  sessionPath: string,
  roomId: string
): void {
  withSessionLock(sessionPath, () => {
    const sessions = readCliSessions(sessionPath).filter(
      (session) => session.room_id !== roomId
    );
    writeCliSessionsUnlocked(sessionPath, sessions);
  });
}

function withSessionLock<T>(sessionPath: string, fn: () => T): T {
  const lockPath = `${sessionPath}.lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 5_000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));

  while (true) {
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (ageMs > 30_000) {
          fs.rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for CLI session lock: ${lockPath}`);
      }
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }

  try {
    return fn();
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

export function findCliSessionForContextPath(
  sessionPath: string,
  agentId: string,
  contextPath: string
): CliSession | null {
  const resolved = resolveContextPath(contextPath);
  const candidates = readCliSessions(sessionPath).filter(
    (session) => session.agent_id === agentId
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
