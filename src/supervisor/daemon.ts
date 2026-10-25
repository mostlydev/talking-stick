import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { Harness, HarnessAdapter, InputMode, InputOutcome, WorkerEvent, WorkerHandle, WorkerSpec } from "./adapter.js";
import type { GenerationState, SupervisorStore, WorkerRow } from "./state.js";

// The reconcile loop: it compares each worker's desired state with what is
// running and acts. Its tick reads process liveness only; it never prompts a
// worker or touches room presence. See docs/supervisor.md.

export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 5 * 60_000;
export const CRASH_WINDOW_MS = 15 * 60_000;
export const CRASH_LIMIT = 5;
export const APPROVAL_EXPIRY_MS = 24 * 60 * 60_000;
export const STOP_GRACE_MS = 10_000;
/** No one worker's start, probe or stop may hold up a tick longer than this. */
export const TICK_WAIT_MS = 15_000;
export const PROBE_TIMEOUT_MS = 5_000;

export type ProcessLivenessReader = (pid: number, processStartedAt: string) => "alive" | "gone" | "unknown";

export interface SupervisorOptions {
  store: SupervisorStore;
  adapters: Partial<Record<Harness, HarnessAdapter>>;
  processLiveness: ProcessLivenessReader;
  now?: () => Date;
  newId?: () => string;
  /** How long one worker may hold up a tick; TICK_WAIT_MS by default. */
  tickWaitMs?: number;
}

/** A decision names the exact request occurrence, not just its native id. */
export interface ApprovalKey {
  approval_id: string;
  worker_id: string;
  generation: number;
}

/** Waits for a promise for at most ms; the promise keeps running. */
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class SupervisorError extends Error {}

export class Supervisor {
  private readonly store: SupervisorStore;
  private readonly adapters: Partial<Record<Harness, HarnessAdapter>>;
  private readonly processLiveness: ProcessLivenessReader;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly handles = new Map<string, WorkerHandle>();
  private readonly starting = new Set<string>();
  private readonly stopping = new Set<string>();
  /** The last state a generation's own events reported, restored after an unknown probe. */
  private readonly reportedState = new Map<string, GenerationState>();
  private reconciled = false;
  private readonly tickWaitMs: number;

  constructor(options: SupervisorOptions) {
    this.store = options.store;
    this.adapters = options.adapters;
    this.processLiveness = options.processLiveness;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
    this.tickWaitMs = options.tickWaitMs ?? TICK_WAIT_MS;
  }

  private at(): string {
    return this.now().toISOString();
  }

  handle(workerId: string): WorkerHandle | undefined {
    return this.handles.get(workerId);
  }

  /**
   * Runs once before any start. A generation recorded as running whose exact
   * process may still be alive holds its worker: the daemon never starts a
   * second copy or adopts a process it cannot prove it owns. A start intent
   * with no recorded child may have spawned one, so it holds too. It must run
   * before the first tick.
   */
  reconcileStartup(): void {
    for (const row of this.store.liveGenerations()) {
      const liveness = row.pid === null || row.process_started_at === null
        ? "unknown" : this.processLiveness(row.pid, row.process_started_at);
      if (liveness === "gone") {
        this.store.endGeneration(row.worker_id, row.generation, this.at(), { reason: "gone_at_startup" });
      } else {
        this.store.hold(row.worker_id, liveness === "alive" ? "prior_generation_alive" : "prior_generation_unknown", this.at());
      }
    }
    this.reconciled = true;
  }

  /** Each worker is reconciled independently and boundedly: one hung handshake freezes no other. */
  async tick(): Promise<void> {
    if (!this.reconciled) throw new SupervisorError("Reconcile recorded generations before the first tick.");
    await Promise.allSettled(this.store.workers().map((worker) => bounded(this.reconcileWorker(worker), this.tickWaitMs)));
  }

  private async reconcileWorker(worker: WorkerRow): Promise<void> {
    const handle = this.handles.get(worker.worker_id);
    if (worker.desired !== "running") {
      if (handle && !this.stopping.has(worker.worker_id)) await this.stopHandle(worker.worker_id, handle);
      return;
    }
    if (handle) {
      // A requested restart stops this generation; the next tick starts the next one.
      if (worker.restart_next) {
        if (!this.stopping.has(worker.worker_id)) await this.stopHandle(worker.worker_id, handle);
        return;
      }
      const liveness = await bounded(handle.probe(), PROBE_TIMEOUT_MS).catch(() => "unknown" as const) ?? "unknown";
      if (liveness === "gone") {
        this.ended(worker.worker_id, handle, { reason: "probe_gone" });
        return;
      }
      const reported = this.reportedState.get(worker.worker_id) ?? "idle";
      this.store.updateGeneration(worker.worker_id, handle.generation, { state: liveness === "unknown" ? "unknown" : reported });
      this.expireApprovals(worker.worker_id, handle);
      return;
    }
    if (worker.hold_reason || this.starting.has(worker.worker_id)) return;
    if (worker.restart_next) this.store.clearRestart(worker.worker_id);
    if (worker.next_start_at && Date.parse(worker.next_start_at) > this.now().getTime()) return;
    await this.start(worker);
  }

  private async start(worker: WorkerRow): Promise<void> {
    const spec = JSON.parse(worker.spec_json) as WorkerSpec;
    const adapter = this.adapters[spec.harness];
    if (!adapter) {
      this.store.hold(worker.worker_id, "start_failed", this.at());
      return;
    }
    const previous = this.store.latestGeneration(worker.worker_id)?.session_id ?? null;
    const resume = worker.fresh_next ? undefined : spec.resume_session_id ?? previous ?? undefined;
    // Continuing a conversation the adapter cannot resume would quietly start a new one.
    if (resume && !adapter.capabilities().resume) {
      this.store.hold(worker.worker_id, "resume_failed", this.at());
      return;
    }
    // The intent is durable before the spawn, and the child the moment it
    // exists, so a crash at any point leaves evidence and never a duplicate.
    const generation = this.store.nextGenerationNumber(worker.worker_id);
    this.store.recordGeneration({ worker_id: worker.worker_id, generation, pid: null, process_started_at: null,
      pgid: null, session_id: null, state: "starting", started_at: this.at() });
    this.starting.add(worker.worker_id);
    let handle: WorkerHandle;
    try {
      handle = await adapter.start({ ...spec, ...(resume ? { resume_session_id: resume } : { resume_session_id: undefined }) },
        generation, (child) => this.store.updateGeneration(worker.worker_id, generation,
          { pid: child.pid, process_started_at: child.processStartedAt, pgid: child.pgid }));
    } catch (error) {
      this.starting.delete(worker.worker_id);
      this.store.endGeneration(worker.worker_id, generation, this.at(), { reason: "start_failed", error: String(error) });
      if (resume) this.store.hold(worker.worker_id, "resume_failed", this.at());
      else this.crashed(worker.worker_id, { reason: "start_failed", error: String(error) });
      return;
    }
    this.starting.delete(worker.worker_id);
    this.store.transaction(() => {
      this.store.updateGeneration(worker.worker_id, generation, { pid: handle.pid, process_started_at: handle.processStartedAt,
        pgid: handle.pgid, session_id: handle.sessionId(), state: "idle" });
      if (worker.fresh_next) this.store.clearFresh(worker.worker_id);
      this.store.audit(this.at(), "supervisor", "start", worker.worker_id, { generation, pid: handle.pid, resumed: Boolean(resume) });
    });
    this.handles.set(worker.worker_id, handle);
    this.reportedState.set(worker.worker_id, "idle");
    handle.onEvent((event) => this.onEvent(worker.worker_id, generation, event));
    // A control change while it started wins: the start was for an older version.
    const current = this.store.worker(worker.worker_id);
    if (!current || current.desired !== "running" || current.desired_version !== worker.desired_version) {
      await this.stopHandle(worker.worker_id, handle);
    }
  }

  /** Stops a generation; a failed stop is audited and the handle kept, never a daemon crash. */
  private async stopHandle(workerId: string, handle: WorkerHandle): Promise<void> {
    this.stopping.add(workerId);
    try {
      await handle.stop(STOP_GRACE_MS);
    } catch (error) {
      this.store.audit(this.at(), "supervisor", "stop_failed", workerId, { generation: handle.generation, error: String(error) });
      return;
    } finally {
      this.stopping.delete(workerId);
    }
    if (this.handles.get(workerId) === handle) this.ended(workerId, handle, { reason: "stopped" });
  }

  private onEvent(workerId: string, generation: number, event: WorkerEvent): void {
    const handle = this.handles.get(workerId);
    // Events from an older generation never touch the current one.
    if (!handle || handle.generation !== generation) return;
    const at = this.at();
    const report = (state: GenerationState, fields: { last_model_activity_at?: string } = {}) => {
      this.reportedState.set(workerId, state);
      this.store.updateGeneration(workerId, generation, { state, ...fields });
    };
    switch (event.type) {
      case "session":
        this.store.updateGeneration(workerId, generation, { session_id: event.session_id });
        break;
      case "input":
        this.store.updateInput(event.input_id, workerId, generation, event.outcome, at, event.native_turn_id);
        break;
      case "turn_started":
        if (event.input_id) this.store.updateInput(event.input_id, workerId, generation, "accepted", at, event.native_turn_id);
        report("busy", { last_model_activity_at: at });
        break;
      case "turn_completed":
        this.store.completeTurn(workerId, generation, event.native_turn_id, event.outcome, at);
        report("idle", { last_model_activity_at: at });
        break;
      case "approval_requested":
        if (!this.store.recordApproval({ approval_id: this.newId(), worker_id: workerId, generation,
          native_request_id: event.native_request_id, tool: event.tool, summary: event.summary.slice(0, 500), requested_at: at })) {
          // A second request under a still-pending id is ambiguous: no decision could name it safely.
          this.store.hold(workerId, "protocol_error", at);
          this.stopHandle(workerId, handle).catch(() => {});
          break;
        }
        report("awaiting_approval");
        break;
      case "state":
        report(event.state);
        break;
      case "overflow":
        this.store.hold(workerId, "overflow", at);
        this.stopHandle(workerId, handle).catch(() => {});
        break;
      case "exited":
        this.ended(workerId, handle, { code: event.code, signal: event.signal });
        break;
    }
  }

  /** A generation is over; restart policy applies unless a human asked for it. */
  private ended(workerId: string, handle: WorkerHandle, exit: Record<string, unknown>): void {
    if (this.handles.get(workerId) !== handle) return;
    this.handles.delete(workerId);
    const { uncertain } = this.store.endGeneration(workerId, handle.generation, this.at(), exit);
    this.store.audit(this.at(), "supervisor", "exit", workerId, { generation: handle.generation, ...exit, uncertain });
    const worker = this.store.worker(workerId);
    const requested = exit.reason === "stopped" || this.stopping.has(workerId);
    if (worker?.desired === "running" && !requested) this.crashed(workerId, exit);
  }

  private crashed(workerId: string, detail: Record<string, unknown>): void {
    const now = this.now();
    this.store.recordCrash(workerId, now.toISOString());
    const count = this.store.crashesSince(workerId, new Date(now.getTime() - CRASH_WINDOW_MS).toISOString());
    if (count >= CRASH_LIMIT) {
      this.store.hold(workerId, "crash_loop", now.toISOString());
      return;
    }
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (count - 1), BACKOFF_MAX_MS);
    this.store.setNextStart(workerId, new Date(now.getTime() + delay).toISOString());
    this.store.audit(now.toISOString(), "supervisor", "backoff", workerId, { ...detail, crashes: count, delay_ms: delay });
  }

  private expireApprovals(workerId: string, handle: WorkerHandle): void {
    const cutoff = this.now().getTime() - APPROVAL_EXPIRY_MS;
    for (const approval of this.store.pendingApprovals()) {
      if (approval.worker_id !== workerId || approval.generation !== handle.generation ||
          Date.parse(approval.requested_at) > cutoff) continue;
      if (this.store.settleApproval(approval.approval_id, "expired", "supervisor", this.at())) {
        this.deliverAnswer(handle, approval.approval_id, approval.native_request_id, "deny", "Expired without a decision.");
      }
    }
  }

  /** Journals the input before writing it, so a crash never loses track of what was sent. */
  async submit(workerId: string, text: string, mode: InputMode, source: string): Promise<{ input_id: string; outcome: InputOutcome }> {
    const handle = this.handles.get(workerId);
    const worker = this.store.worker(workerId);
    // A pause, stop or hold takes effect for input at once, before the next tick.
    if (!handle || !worker || worker.desired !== "running" || worker.hold_reason || this.stopping.has(workerId)) {
      throw new SupervisorError(`Worker ${workerId} is not running.`);
    }
    const spec = JSON.parse(worker.spec_json) as WorkerSpec;
    if (!this.adapters[spec.harness]?.capabilities().prompt) {
      throw new SupervisorError(`The ${spec.harness} adapter cannot take a prompt.`);
    }
    const inputId = this.newId();
    const generation = handle.generation;
    this.store.journalInput({ input_id: inputId, worker_id: workerId, generation, mode, source, created_at: this.at() });
    // Recorded before the write, so a crash while writing leaves it uncertain.
    this.store.updateInput(inputId, workerId, generation, "dispatching", this.at());
    let outcome: InputOutcome;
    try {
      outcome = await handle.submit({ input_id: inputId, text, mode });
    } catch {
      outcome = "uncertain";
    }
    this.store.updateInput(inputId, workerId, generation, outcome, this.at());
    return { input_id: inputId, outcome };
  }

  /**
   * Decides one request occurrence of one live generation; anything else is
   * refused. The decision is durable even if delivering the answer fails,
   * and the delivery outcome is recorded separately.
   */
  async decideApproval(key: ApprovalKey, decision: "allow" | "deny", actor: string, note?: string): Promise<"delivered" | "failed"> {
    const handle = this.handles.get(key.worker_id);
    const approval = this.store.approval(key.approval_id);
    if (!handle || handle.generation !== key.generation || !approval ||
        approval.worker_id !== key.worker_id || approval.generation !== key.generation) {
      throw new SupervisorError(`Generation ${key.generation} of ${key.worker_id} is not running that request.`);
    }
    if (!this.store.settleApproval(key.approval_id, decision === "allow" ? "allowed" : "denied", actor, this.at())) {
      throw new SupervisorError(`Request ${key.approval_id} is not pending.`);
    }
    this.store.audit(this.at(), actor, `approval_${decision}`, key.worker_id, key);
    return this.deliverAnswer(handle, approval.approval_id, approval.native_request_id, decision, note);
  }

  private async deliverAnswer(handle: WorkerHandle, approvalId: string, nativeRequestId: string,
    decision: "allow" | "deny", note?: string): Promise<"delivered" | "failed"> {
    try {
      await handle.answerApproval(nativeRequestId, decision, note);
      this.store.recordAnswer(approvalId, "delivered");
      return "delivered";
    } catch (error) {
      this.store.recordAnswer(approvalId, "failed");
      this.store.audit(this.at(), "supervisor", "approval_answer_failed", null, { approval_id: approvalId, error: String(error) });
      return "failed";
    }
  }

  async interrupt(workerId: string, actor: string): Promise<"interrupted" | "not_busy" | "unsupported"> {
    const handle = this.handles.get(workerId);
    if (!handle) throw new SupervisorError(`Worker ${workerId} is not running.`);
    this.store.audit(this.at(), actor, "interrupt", workerId, { generation: handle.generation });
    return handle.interrupt();
  }
}

/**
 * One supervisor per data directory. The lock file names the owner's exact
 * process. A lock whose owner is gone is taken over, never one that may live,
 * and reapers are serialized so two of them never both take it.
 */
export function acquireOwnerLock(
  lockPath: string,
  self: { pid: number; process_started_at: string },
  liveness: ProcessLivenessReader
): () => void {
  const content = JSON.stringify(self);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeSync(fd, content);
      fs.closeSync(fd);
      return () => {
        try { if (fs.readFileSync(lockPath, "utf8") === content) fs.unlinkSync(lockPath); } catch { /* already gone */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const reaper = `${lockPath}.reap`;
    try {
      fs.mkdirSync(reaper);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new SupervisorError(`Another supervisor is taking over ${lockPath}; recovery guard ${reaper}.`);
      }
      throw error;
    }
    try {
      let owner: { pid: number; process_started_at: string } | null = null;
      try { owner = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid: number; process_started_at: string }; }
      catch { /* Unreadable owner evidence is uncertain; never break the lock. */ }
      if (!owner || liveness(owner.pid, owner.process_started_at) !== "gone") {
        throw new SupervisorError(`Another supervisor owns ${lockPath}${owner ? ` (pid ${owner.pid})` : ""}.`);
      }
      // Only a reaper removes a lock, and only one reaper runs, so this is the dead owner's.
      fs.unlinkSync(lockPath);
    } finally {
      fs.rmSync(reaper, { recursive: true, force: true });
    }
  }
  throw new SupervisorError(`Could not take ${lockPath}.`);
}
