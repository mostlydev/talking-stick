import fs from "node:fs";
import path from "node:path";
import { openSqlite, type SqliteDatabase } from "../sqlite.js";
import { withImmediateTransaction } from "../db.js";
import type { InputMode, InputOutcome, WorkerSpec } from "./adapter.js";

// The supervisor's durable desired and observed state, in its own database
// beside the room database, so room migrations never depend on it.

export type DesiredState = "running" | "paused" | "stopped";

export type GenerationState =
  | "starting" | "idle" | "busy" | "awaiting_approval" | "awaiting_input"
  | "disconnected" | "unknown" | "auth_required" | "dead";

export type HoldReason =
  | "crash_loop" | "prior_generation_alive" | "prior_generation_unknown"
  | "resume_failed" | "overflow" | "start_failed" | "protocol_error";

export interface WorkerRow {
  worker_id: string;
  spec_json: string;
  desired: DesiredState;
  desired_version: number;
  created_by: string;
  created_at: string;
  hold_reason: HoldReason | null;
  next_start_at: string | null;
  /** Set by an operator's fresh restart: the next start begins a new conversation. */
  fresh_next: number;
  /** Set by an operator's restart: the running generation is stopped and started again. */
  restart_next: number;
}

export interface GenerationRow {
  worker_id: string;
  generation: number;
  /** Null until the adapter reports the spawned child: a start intent. */
  pid: number | null;
  process_started_at: string | null;
  pgid: number | null;
  session_id: string | null;
  state: GenerationState;
  started_at: string;
  ended_at: string | null;
  exit_json: string | null;
  last_model_activity_at: string | null;
}

export interface InputRow {
  input_id: string;
  worker_id: string;
  generation: number;
  mode: InputMode;
  source: string;
  state: InputState;
  native_turn_id: string | null;
  turn_outcome: "success" | "error" | "interrupted" | null;
  created_at: string;
  updated_at: string;
}

/**
 * An input's life. Dispatching is recorded before the write is attempted, so a
 * crash during it is uncertain, never rejected. States only move forward, and
 * completed, rejected and uncertain are final.
 */
export type InputState = "journalled" | "dispatching" | InputOutcome | "completed";

const INPUT_RANK: Record<string, number> = { journalled: 0, dispatching: 1, written: 2, queued: 3, accepted: 4, completed: 5 };

export function inputAdvances(current: InputState, next: InputState): boolean {
  if (current === "completed" || current === "rejected" || current === "uncertain") return false;
  // A turn that started is certain, so a late uncertain or rejected result cannot undo it.
  if (next === "uncertain" || next === "rejected") return INPUT_RANK[current] < INPUT_RANK.accepted;
  return INPUT_RANK[next] > INPUT_RANK[current];
}

export interface ApprovalRow {
  /** Unique per request: a native id reused in one generation is a new request. */
  approval_id: string;
  worker_id: string;
  generation: number;
  native_request_id: string;
  tool: string;
  summary: string;
  status: "pending" | "allowed" | "denied" | "expired";
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  /** Whether the decided answer reached the worker; separate from the decision. */
  answer_status: "pending" | "delivered" | "failed" | null;
}

const MIGRATIONS: Array<{ id: number; up: string }> = [{
  id: 1,
  up: `CREATE TABLE workers (
    worker_id TEXT PRIMARY KEY,
    spec_json TEXT NOT NULL,
    desired TEXT NOT NULL,
    desired_version INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    hold_reason TEXT,
    next_start_at TEXT,
    fresh_next INTEGER NOT NULL DEFAULT 0,
    restart_next INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE generations (
    worker_id TEXT NOT NULL REFERENCES workers(worker_id) ON DELETE CASCADE,
    generation INTEGER NOT NULL,
    pid INTEGER,
    process_started_at TEXT,
    pgid INTEGER,
    session_id TEXT,
    state TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    exit_json TEXT,
    last_model_activity_at TEXT,
    PRIMARY KEY (worker_id, generation)
  );
  CREATE TABLE crashes (worker_id TEXT NOT NULL, at TEXT NOT NULL);
  CREATE TABLE inputs (
    input_id TEXT PRIMARY KEY,
    worker_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    mode TEXT NOT NULL,
    source TEXT NOT NULL,
    state TEXT NOT NULL,
    native_turn_id TEXT,
    turn_outcome TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE approvals (
    approval_id TEXT PRIMARY KEY,
    worker_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    native_request_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    summary TEXT NOT NULL,
    status TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    decided_by TEXT,
    decided_at TEXT,
    answer_status TEXT
  );
  CREATE UNIQUE INDEX approvals_one_pending ON approvals (worker_id, generation, native_request_id)
    WHERE status = 'pending';
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    worker_id TEXT,
    detail TEXT
  );`
}];

export function supervisorDatabasePath(dataDir: string): string {
  return path.join(dataDir, "supervisor.sqlite");
}

export class SupervisorStore {
  readonly db: SqliteDatabase;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    try { fs.closeSync(fs.openSync(dbPath, "wx", 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    this.db = openSqlite(dbPath, { timeout: 5000 });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const applied = new Set(this.db.prepare<[], { id: number }>("SELECT id FROM schema_migrations").all().map((row) => row.id));
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.id)) continue;
      this.transaction(() => {
        this.db.exec(migration.up);
        this.db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(migration.id, new Date().toISOString());
      });
    }
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  transaction<T>(fn: () => T): T {
    return this.db.inTransaction ? fn() : withImmediateTransaction(this.db, fn);
  }

  audit(at: string, actor: string, action: string, workerId: string | null, detail?: unknown): void {
    this.db.prepare("INSERT INTO audit (at, actor, action, worker_id, detail) VALUES (?, ?, ?, ?, ?)")
      .run(at, actor, action, workerId, detail === undefined ? null : JSON.stringify(detail));
  }

  addWorker(spec: WorkerSpec, actor: string, at: string): WorkerRow {
    return this.transaction(() => {
      this.db.prepare(`INSERT INTO workers (worker_id, spec_json, desired, desired_version, created_by, created_at)
        VALUES (?, ?, 'running', 1, ?, ?)`).run(spec.worker_id, JSON.stringify(spec), actor, at);
      this.audit(at, actor, "add", spec.worker_id, { harness: spec.harness });
      return this.worker(spec.worker_id)!;
    });
  }

  worker(workerId: string): WorkerRow | null {
    return this.db.prepare<[string], WorkerRow>("SELECT * FROM workers WHERE worker_id = ?").get(workerId) ?? null;
  }

  workers(): WorkerRow[] {
    return this.db.prepare<[], WorkerRow>("SELECT * FROM workers ORDER BY worker_id").all();
  }

  /** A control change: bumps the version so any in-flight action on the old one loses. */
  setDesired(workerId: string, desired: DesiredState, actor: string, at: string, clearHold = false): WorkerRow {
    return this.transaction(() => {
      const changed = this.db.prepare(`UPDATE workers SET desired = ?, desired_version = desired_version + 1
        ${clearHold ? ", hold_reason = NULL, next_start_at = NULL" : ""} WHERE worker_id = ?`).run(desired, workerId);
      if (changed.changes !== 1) throw new Error(`No worker named ${workerId}.`);
      this.audit(at, actor, desired === "running" ? "resume" : desired === "paused" ? "pause" : "stop", workerId);
      return this.worker(workerId)!;
    });
  }

  hold(workerId: string, reason: HoldReason, at: string): void {
    this.db.prepare("UPDATE workers SET hold_reason = ? WHERE worker_id = ?").run(reason, workerId);
    this.audit(at, "supervisor", "hold", workerId, { reason });
  }

  setNextStart(workerId: string, at: string | null): void {
    this.db.prepare("UPDATE workers SET next_start_at = ? WHERE worker_id = ?").run(at, workerId);
  }

  liveGenerations(): GenerationRow[] {
    return this.db.prepare<[], GenerationRow>("SELECT * FROM generations WHERE ended_at IS NULL").all();
  }

  generation(workerId: string, generation: number): GenerationRow | null {
    return this.db.prepare<[string, number], GenerationRow>(
      "SELECT * FROM generations WHERE worker_id = ? AND generation = ?").get(workerId, generation) ?? null;
  }

  latestGeneration(workerId: string): GenerationRow | null {
    return this.db.prepare<[string], GenerationRow>(
      "SELECT * FROM generations WHERE worker_id = ? ORDER BY generation DESC LIMIT 1").get(workerId) ?? null;
  }

  nextGenerationNumber(workerId: string): number {
    return (this.latestGeneration(workerId)?.generation ?? 0) + 1;
  }

  recordGeneration(row: Omit<GenerationRow, "ended_at" | "exit_json" | "last_model_activity_at">): void {
    this.db.prepare(`INSERT INTO generations (worker_id, generation, pid, process_started_at, pgid, session_id, state, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(row.worker_id, row.generation, row.pid, row.process_started_at, row.pgid,
        row.session_id, row.state, row.started_at);
  }

  updateGeneration(workerId: string, generation: number, fields: Partial<Pick<GenerationRow,
    "session_id" | "state" | "last_model_activity_at" | "pid" | "process_started_at" | "pgid">>): void {
    const entries = Object.entries(fields);
    if (!entries.length) return;
    this.db.prepare(`UPDATE generations SET ${entries.map(([key]) => `${key} = ?`).join(", ")}
      WHERE worker_id = ? AND generation = ? AND ended_at IS NULL`)
      .run(...entries.map(([, value]) => value as string | number | null), workerId, generation);
  }

  /**
   * A generation has ended. Inputs it wrote but never saw complete become
   * uncertain, and its pending approvals expire: nothing carries over.
   */
  endGeneration(workerId: string, generation: number, at: string, exit: unknown): { uncertain: number } {
    return this.transaction(() => {
      this.db.prepare(`UPDATE generations SET ended_at = ?, state = 'dead', exit_json = ?
        WHERE worker_id = ? AND generation = ? AND ended_at IS NULL`).run(at, JSON.stringify(exit), workerId, generation);
      // Anything that may have reached the process is uncertain; only input
      // never dispatched is rejected.
      const uncertain = this.db.prepare(`UPDATE inputs SET state = 'uncertain', updated_at = ?
        WHERE worker_id = ? AND generation = ? AND state IN ('dispatching', 'written', 'queued', 'accepted')`).run(at, workerId, generation).changes;
      this.db.prepare(`UPDATE inputs SET state = 'rejected', updated_at = ?
        WHERE worker_id = ? AND generation = ? AND state = 'journalled'`).run(at, workerId, generation);
      this.db.prepare(`UPDATE approvals SET status = 'expired', decided_by = 'supervisor', decided_at = ?, answer_status = 'failed'
        WHERE worker_id = ? AND generation = ? AND status = 'pending'`).run(at, workerId, generation);
      return { uncertain };
    });
  }

  recordCrash(workerId: string, at: string): void {
    this.db.prepare("INSERT INTO crashes (worker_id, at) VALUES (?, ?)").run(workerId, at);
  }

  crashesSince(workerId: string, since: string): number {
    return this.db.prepare<[string, string], { count: number }>(
      "SELECT COUNT(*) AS count FROM crashes WHERE worker_id = ? AND at >= ?").get(workerId, since)?.count ?? 0;
  }

  journalInput(row: Omit<InputRow, "state" | "native_turn_id" | "turn_outcome" | "updated_at">): void {
    this.db.prepare(`INSERT INTO inputs (input_id, worker_id, generation, mode, source, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'journalled', ?, ?)`).run(row.input_id, row.worker_id, row.generation, row.mode,
        row.source, row.created_at, row.created_at);
  }

  /** Moves one generation's input forward only; final states never change. */
  updateInput(inputId: string, workerId: string, generation: number, state: InputState, at: string, nativeTurnId?: string): void {
    this.transaction(() => {
      const current = this.db.prepare<[string, string, number], InputRow>(
        "SELECT * FROM inputs WHERE input_id = ? AND worker_id = ? AND generation = ?").get(inputId, workerId, generation);
      if (!current) return;
      if (nativeTurnId && !current.native_turn_id) {
        this.db.prepare("UPDATE inputs SET native_turn_id = ? WHERE input_id = ?").run(nativeTurnId, inputId);
      }
      if (!inputAdvances(current.state, state)) return;
      this.db.prepare("UPDATE inputs SET state = ?, updated_at = ? WHERE input_id = ?").run(state, at, inputId);
    });
  }

  /** The inputs that started or joined a turn are done when it completes, with its outcome. */
  completeTurn(workerId: string, generation: number, nativeTurnId: string,
    outcome: "success" | "error" | "interrupted", at: string): void {
    this.db.prepare(`UPDATE inputs SET state = 'completed', turn_outcome = ?, updated_at = ?
      WHERE worker_id = ? AND generation = ? AND native_turn_id = ?
      AND state IN ('dispatching', 'written', 'queued', 'accepted')`)
      .run(outcome, at, workerId, generation, nativeTurnId);
  }

  /**
   * An operator's restart: the running generation stops and the next one
   * resumes its session, or with fresh, begins a new conversation.
   */
  requestRestart(workerId: string, fresh: boolean, actor: string, at: string): WorkerRow {
    return this.transaction(() => {
      const changed = this.db.prepare(`UPDATE workers SET desired = 'running', desired_version = desired_version + 1,
        hold_reason = NULL, next_start_at = NULL, restart_next = 1, fresh_next = ? WHERE worker_id = ?`).run(fresh ? 1 : 0, workerId);
      if (changed.changes !== 1) throw new Error(`No worker named ${workerId}.`);
      this.audit(at, actor, fresh ? "restart_fresh" : "restart", workerId);
      return this.worker(workerId)!;
    });
  }

  clearRestart(workerId: string): void {
    this.db.prepare("UPDATE workers SET restart_next = 0 WHERE worker_id = ?").run(workerId);
  }

  clearFresh(workerId: string): void {
    this.db.prepare("UPDATE workers SET fresh_next = 0 WHERE worker_id = ?").run(workerId);
  }

  input(inputId: string): InputRow | null {
    return this.db.prepare<[string], InputRow>("SELECT * FROM inputs WHERE input_id = ?").get(inputId) ?? null;
  }

  /**
   * Records a request. A native id still pending in the same generation is a
   * protocol error, so the worker is held; a reused id after it settled is a
   * new request with its own approval id.
   */
  recordApproval(row: Omit<ApprovalRow, "status" | "decided_by" | "decided_at" | "answer_status">): boolean {
    if (this.pendingApproval(row.worker_id, row.generation, row.native_request_id)) return false;
    this.db.prepare(`INSERT INTO approvals (approval_id, worker_id, generation, native_request_id, tool, summary, status, requested_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`).run(row.approval_id, row.worker_id, row.generation,
        row.native_request_id, row.tool, row.summary, row.requested_at);
    return true;
  }

  approval(approvalId: string): ApprovalRow | null {
    return this.db.prepare<[string], ApprovalRow>("SELECT * FROM approvals WHERE approval_id = ?").get(approvalId) ?? null;
  }

  pendingApproval(workerId: string, generation: number, nativeRequestId: string): ApprovalRow | null {
    return this.db.prepare<[string, number, string], ApprovalRow>(`SELECT * FROM approvals
      WHERE worker_id = ? AND generation = ? AND native_request_id = ? AND status = 'pending'`)
      .get(workerId, generation, nativeRequestId) ?? null;
  }

  pendingApprovals(): ApprovalRow[] {
    return this.db.prepare<[], ApprovalRow>("SELECT * FROM approvals WHERE status = 'pending' ORDER BY requested_at").all();
  }

  /** Settles one pending request; false when it was not pending. */
  settleApproval(approvalId: string, status: "allowed" | "denied" | "expired", actor: string, at: string): boolean {
    return this.db.prepare(`UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, answer_status = 'pending'
      WHERE approval_id = ? AND status = 'pending'`).run(status, actor, at, approvalId).changes === 1;
  }

  recordAnswer(approvalId: string, answer: "delivered" | "failed"): void {
    this.db.prepare("UPDATE approvals SET answer_status = ? WHERE approval_id = ?").run(answer, approvalId);
  }

  auditRows(workerId?: string): Array<{ at: string; actor: string; action: string; worker_id: string | null; detail: string | null }> {
    return workerId
      ? this.db.prepare<[string], { at: string; actor: string; action: string; worker_id: string | null; detail: string | null }>(
        "SELECT at, actor, action, worker_id, detail FROM audit WHERE worker_id = ? ORDER BY id").all(workerId)
      : this.db.prepare<[], { at: string; actor: string; action: string; worker_id: string | null; detail: string | null }>(
        "SELECT at, actor, action, worker_id, detail FROM audit ORDER BY id").all();
  }
}
