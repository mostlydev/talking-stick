import { openSqlite, type SqliteDatabase } from "../sqlite.js";
import type { WorkerPermissions, WorkerSpec } from "./adapter.js";
import { readSupervisorOwnerLock, type ProcessLivenessReader } from "./daemon.js";
import { executableFailure } from "./executable.js";
import { inspectSupervisorState } from "./root.js";
import { supervisorPaths, systemProcessLiveness } from "./run.js";
import { MEMBERSHIP_STOP_REASON_SQL, type DesiredState, type GenerationState, type HoldReason } from "./state.js";

interface WorkerStatusRow {
  worker_id: string;
  spec_json: string;
  desired: DesiredState;
  desired_version: number;
  hold_reason: HoldReason | null;
  next_start_at: string | null;
  stop_reason: string | null;
  generation: number | null;
  generation_state: GenerationState | null;
  pid: number | null;
  process_started_at: string | null;
  session_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  last_model_activity_at: string | null;
  exit_json: string | null;
  queued_inputs: number;
  uncertain_inputs: number;
  denied_requests: number;
}

export function hasUnrestrictedPermissions(permissions?: WorkerPermissions): boolean {
  if (!permissions) return false;
  if (permissions.harness === "codex") {
    return permissions.sandbox === "danger-full-access" && permissions.approval === "never";
  }
  return permissions.mode === "bypassPermissions";
}

export function readSupervisorWorkers(db: SqliteDatabase) {
  // One statement keeps worker, generation and request counts from the same
  // committed view, even while the supervisor is changing them.
  const rows = db.prepare<[], WorkerStatusRow>(`
    SELECT w.worker_id, w.spec_json, w.desired, w.desired_version, w.hold_reason, w.next_start_at,
           g.generation, g.state AS generation_state, g.pid, g.process_started_at, g.session_id,
           g.started_at, g.ended_at, g.last_model_activity_at,
           g.exit_json,
           CASE WHEN w.desired != 'running' THEN ${MEMBERSHIP_STOP_REASON_SQL} END AS stop_reason,
           COALESCE(q.count, 0) AS queued_inputs,
           COALESCE(i.count, 0) AS uncertain_inputs, COALESCE(a.count, 0) AS denied_requests
    FROM workers w
    LEFT JOIN generations g ON g.worker_id = w.worker_id AND g.generation = (
      SELECT MAX(latest.generation) FROM generations latest WHERE latest.worker_id = w.worker_id
    )
    LEFT JOIN (
      SELECT worker_id, generation, COUNT(*) AS count
      FROM inputs
      WHERE (source = 'tt_envelope' AND state = 'journalled') OR state = 'queued'
      GROUP BY worker_id, generation
    ) q ON q.worker_id = g.worker_id AND q.generation = g.generation AND g.ended_at IS NULL
    LEFT JOIN (SELECT worker_id, COUNT(*) AS count FROM inputs WHERE state = 'uncertain' GROUP BY worker_id) i
      ON i.worker_id = w.worker_id
    LEFT JOIN (SELECT worker_id, COUNT(*) AS count FROM approvals WHERE status = 'denied' GROUP BY worker_id) a
      ON a.worker_id = w.worker_id
    ORDER BY w.worker_id
  `).all();
  return rows.map((row) => {
    const spec = JSON.parse(row.spec_json) as WorkerSpec;
    const executableEnv = row.hold_reason === "start_failed" || row.hold_reason === "crash_loop"
      ? executableFailure(spec.harness, row.exit_json, row.pid) : undefined;
    const executable = spec.harness === "antigravity" ? "agy" : spec.harness;
    const pinnedPath = executableEnv && spec.env?.some(ref =>
      ref.name === executableEnv || (ref.name === "PATH" && ref.from === "literal"));
    return {
      worker_id: row.worker_id,
      harness: spec.harness,
      ...(spec.adoption ? { adoption: spec.adoption } : {}),
      ...(hasUnrestrictedPermissions(spec.permissions) ? { unrestricted: true as const } : {}),
      cwd: spec.cwd,
      desired: row.desired,
      desired_version: row.desired_version,
      hold_reason: row.stop_reason ? null : row.hold_reason,
      ...(row.stop_reason ? { stop_reason: row.stop_reason } : {}),
      next_start_at: row.hold_reason ? null : row.next_start_at,
      generation: row.generation === null ? null : {
        generation: row.generation,
        state: row.generation_state!,
        pid: row.pid,
        session_id: row.session_id,
        started_at: row.started_at!,
        ended_at: row.ended_at,
        last_model_activity_at: row.last_model_activity_at
      },
      ...(executableEnv ? {
        start_error: `Cannot resolve the ${spec.harness} executable (${executableEnv}).`,
        start_remedy: pinnedPath
          ? `Run tt supervisor stop ${row.worker_id}, then tt supervisor remove ${row.worker_id}. Re-add it with --env ${executableEnv}=literal:/absolute/executable.`
          : `Run tt supervisor install (macOS) or tt supervisor run from a shell with ${executable} on PATH, then tt supervisor resume ${row.worker_id}.`
      } : {}),
      ...(row.hold_reason === "executable_ready" ? {
        start_remedy: `Executable found at supervisor startup. Run tt supervisor resume ${row.worker_id}.`
      } : {}),
      generation_process_started_at: row.process_started_at,
      queued_inputs: row.queued_inputs,
      uncertain_inputs: row.uncertain_inputs,
      denied_requests: row.denied_requests
    };
  });
}

export type SupervisorWorkerStatus = ReturnType<typeof readSupervisorWorkers>[number];
export type SupervisorDaemonStatus = "running" | "stopped" | "unknown";
export type SupervisorSnapshot =
  | { kind: "none" }
  | { kind: "needs_migration" }
  | { kind: "unavailable"; reason: "state" | "database" }
  | { kind: "ready"; daemon: SupervisorDaemonStatus; workers: SupervisorWorkerStatus[] };

export function readSupervisorDaemonStatus(lockPath: string, liveness?: ProcessLivenessReader): SupervisorDaemonStatus {
  const owner = readSupervisorOwnerLock(lockPath);
  if (owner === "missing") return "stopped";
  if (owner === "unknown") return "unknown";
  try {
    const result = (liveness ?? systemProcessLiveness())(owner.pid, owner.process_started_at);
    return result === "alive" ? "running" : result === "gone" ? "stopped" : "unknown";
  } catch {
    return "unknown";
  }
}

export function readSupervisorSnapshot(dataDir: string, options: {
  env?: NodeJS.ProcessEnv;
  liveness?: ProcessLivenessReader;
} = {}): SupervisorSnapshot {
  let state: ReturnType<typeof inspectSupervisorState>;
  try {
    state = inspectSupervisorState(dataDir, options.env);
  } catch {
    return { kind: "unavailable", reason: "state" };
  }
  if (state.kind === "none") return { kind: "none" };
  if (state.kind !== "ready") return { kind: "needs_migration" };

  const paths = supervisorPaths(state.root.dir);
  let workers: SupervisorWorkerStatus[];
  try {
    const db = openSqlite(paths.database, { readonly: true, timeout: 25 });
    try {
      workers = readSupervisorWorkers(db);
    } finally {
      db.close();
    }
  } catch {
    return { kind: "unavailable", reason: "database" };
  }
  return { kind: "ready", daemon: readSupervisorDaemonStatus(paths.lock, options.liveness), workers };
}
