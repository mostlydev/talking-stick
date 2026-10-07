import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { createSystemProcessInspector, getCurrentProcessStartedAt, type ProcessInspector } from "./process-utils.js";
import { randomUUID } from "node:crypto";

// One record per canonical path remembers which panes a launch created and how
// far each agent got, so a rerun can tell "ours, still starting" from "free".
export type LaunchAgentState =
  | "pane_created"
  | "starting"
  | "started"
  | "confirmed"
  | "blocked"
  | "ambiguous"
  | "failed";

export interface LaunchRecordAgent {
  herdr_name: string;
  pane_id: string | null;
  state: LaunchAgentState;
  detail?: string;
  member_id?: string;
  updated_at: string;
}

export interface LaunchRecord {
  canonical_path: string;
  chat_pane_id: string | null;
  anchor?: { state: "creating" | "created" | "ambiguous" | "failed"; pane_id: string | null };
  chat_state?: "starting" | "opened" | "ambiguous" | "failed";
  agents: Record<string, LaunchRecordAgent>;
  updated_at: string;
}

export const LAUNCH_LOCK_TIMEOUT_MS = 5_000;

export function launchKey(canonicalPath: string): string {
  return createHash("sha256").update(canonicalPath).digest("hex").slice(0, 16);
}

export function launchRecordPath(dataDir: string, canonicalPath: string): string {
  return path.join(dataDir, "launches", `${launchKey(canonicalPath)}.json`);
}

export function readLaunchRecord(dataDir: string, canonicalPath: string): LaunchRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(launchRecordPath(dataDir, canonicalPath), "utf8")) as LaunchRecord;
    return parsed.canonical_path === canonicalPath ? parsed : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function writeLaunchRecord(dataDir: string, record: LaunchRecord): void {
  const target = launchRecordPath(dataDir, record.canonical_path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  writeFileAtomic(target, `${JSON.stringify(record, null, 2)}\n`);
}

// Serializes launches for one path. A second launcher fails fast instead of
// racing the first into duplicate panes.
export function acquireLaunchLock(
  dataDir: string,
  canonicalPath: string,
  options: { timeoutMs?: number; now?: () => number; inspector?: ProcessInspector } = {}
): () => void {
  const lockPath = `${launchRecordPath(dataDir, canonicalPath)}.lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? LAUNCH_LOCK_TIMEOUT_MS);
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const inspector = options.inspector ?? createSystemProcessInspector();
  const owner = { pid: process.pid, started_at: getCurrentProcessStartedAt(), token: randomUUID() };
  const ownerPath = path.join(lockPath, "owner.json");
  while (true) {
    try {
      fs.mkdirSync(lockPath);
      try { writeFileAtomic(ownerPath, JSON.stringify(owner)); }
      catch (error) { fs.rmSync(lockPath, { recursive: true, force: true }); throw error; }
      return () => {
        try {
          if (JSON.parse(fs.readFileSync(ownerPath, "utf8")).token === owner.token) {
            fs.rmSync(lockPath, { recursive: true, force: true });
          }
        } catch { /* An absent/replaced lock is not ours to remove. */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Age cannot prove a writer is dead: the operator may choose a long join
    // timeout. Serialize reapers too, then inspect the exact process owner.
    const reaper = `${lockPath}.reap`;
    let reaping = false;
    try {
      fs.mkdirSync(reaper);
      reaping = true;
      const previous = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
      if (Number.isInteger(previous.pid) && typeof previous.started_at === "string") {
        const live = inspector.inspect(previous.pid);
        if (live === null || (live?.startTime && live.startTime.trim() !== previous.started_at.trim())) {
          fs.rmSync(lockPath, { recursive: true, force: true });
        }
      }
    } catch { /* Missing owner evidence is uncertain; never break the lock. */ }
    finally { if (reaping) fs.rmSync(reaper, { recursive: true, force: true }); }
    if (!fs.existsSync(lockPath)) continue;
    if (now() >= deadline) {
      throw new Error(`Another tt up may be launching ${canonicalPath}. Lock: ${lockPath}; recovery guard: ${reaper}. Inspect the owner before removing either path.`);
    }
    Atomics.wait(sleeper, 0, 0, 50);
  }
}
