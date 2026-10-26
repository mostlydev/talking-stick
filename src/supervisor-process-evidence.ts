import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { writeFileAtomic } from "./atomic-write.js";

// This is evidence supplied to an already selected native PID, not an
// authority to select a PID, join a room or acquire a writer lease.
export function createProcessEvidence(input: { stateDir: string; workerId: string; generation: number;
  harness: string; endpoint: string; token: string }) {
  const dir = path.join(input.stateDir, "workers", input.workerId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, `process-${input.generation}.json`);
  return { file,
    record(process: { pid: number; processStartedAt: string }): void {
      writeFileAtomic(file, JSON.stringify({ harness: input.harness, pid: process.pid,
        process_started_at: process.processStartedAt, endpoint: input.endpoint,
        token_hash: createHash("sha256").update(input.token).digest("hex") }), 0o600);
    },
    clear(): void {
      // Cleanup must not turn a child exit into an uncaught daemon failure.
      // A leftover file cannot authenticate a later generation's token.
      try { fs.rmSync(file, { force: true }); } catch { /* Stale evidence remains unusable. */ }
    }
  };
}

/** A sandbox can deny ps; mismatched or stale evidence still means unknown. */
export function readProcessStartEvidence(env: NodeJS.ProcessEnv, harness: string, selectedPid: number): string | null {
  if (!env.TT_SUPERVISOR_PROCESS_FILE || !env.TT_SUPERVISOR_TOKEN || !env.TT_SUPERVISOR_ENDPOINT) return null;
  try {
    const stat = fs.lstatSync(env.TT_SUPERVISOR_PROCESS_FILE);
    if (!stat.isFile() || stat.size > 4096) return null;
    const evidence = JSON.parse(fs.readFileSync(env.TT_SUPERVISOR_PROCESS_FILE, "utf8"));
    if (evidence.harness === harness && evidence.pid === selectedPid &&
        evidence.endpoint === env.TT_SUPERVISOR_ENDPOINT &&
        evidence.token_hash === createHash("sha256").update(env.TT_SUPERVISOR_TOKEN).digest("hex") &&
        typeof evidence.process_started_at === "string" && evidence.process_started_at.trim()) {
      return evidence.process_started_at.trim();
    }
  } catch { /* Missing or unreadable evidence never fabricates a start time. */ }
  return null;
}
