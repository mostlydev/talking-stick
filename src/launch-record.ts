import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";

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
  agents: Record<string, LaunchRecordAgent>;
  updated_at: string;
}

export const LAUNCH_LOCK_TIMEOUT_MS = 5_000;
// A launch runs agent starts and a bounded join wait; anything older is stale.
export const LAUNCH_LOCK_STALE_MS = 10 * 60_000;

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
  options: { timeoutMs?: number; staleMs?: number; now?: () => number } = {}
): () => void {
  const lockPath = `${launchRecordPath(dataDir, canonicalPath)}.lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? LAUNCH_LOCK_TIMEOUT_MS);
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    try {
      fs.mkdirSync(lockPath);
      return () => fs.rmSync(lockPath, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    try {
      if (now() - fs.statSync(lockPath).mtimeMs > (options.staleMs ?? LAUNCH_LOCK_STALE_MS)) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
    } catch {
      continue;
    }
    if (now() >= deadline) {
      throw new Error(`Another tt up is already launching ${canonicalPath}; wait for it to finish.`);
    }
    Atomics.wait(sleeper, 0, 0, 50);
  }
}
