import fs from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Harness, HarnessAdapter, InputMode, InputOutcome, WorkerEvent, WorkerHandle, WorkerSpec } from "./adapter.js";
import type { GenerationState, SupervisorStore, WorkerRow } from "./state.js";
import type { IntakeAnswer, IntakeMessage } from "./intake.js";
import type { RoomBridge } from "./room-bridge.js";
import { resolveBundledSkillPath } from "../skill-install.js";
import { displayText, safeDetail } from "./approval-detail.js";
import { CONTROL_LOCKED_MESSAGE as CONTROL_LOCKED_ERROR } from "../service.js";
import { LOCKED_GATE, type GateRequest, type GateResult, type HumanGate } from "./human-gate.js";

// The reconcile loop: it compares each worker's desired state with what is
// running and acts. Its probes never prompt a worker or touch room presence. The
// sole initial enrolment prompt is journalled once per native session. See docs/supervisor.md.

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
  /** The room side and the intake socket; without them workers get no supervisor endpoint. */
  bridge?: RoomBridge;
  socketPath?: string;
  /** Explicit opt-in for the production daemon; one enrolment turn per native session. */
  bootstrap?: boolean;
  /** The supervisor's tt data directory, given to every worker so its tt calls land in this room database. */
  dataDir?: string;
  /** The protected root for supervisor-owned state; each worker's native home and evidence go under it. */
  stateDir?: string;
  /** The human-control gate every control request must pass; locked by default. */
  gate?: HumanGate;
  /** How long a human has to confirm one request; GATE_TIMEOUT_MS by default. */
  gateTimeoutMs?: number;
}

export const GATE_TIMEOUT_MS = 120_000;

/** A control request as it arrives, before the gate: the caller names exactly what it means. */
export interface ControlRequest {
  action: "approve" | "deny" | "interrupt";
  actor: string;
  approval_id?: string;
  worker_id?: string;
  /** The detail digest the requester reviewed; an approval needs it, in full or as a 12+ hex prefix. */
  detail_sha256?: string;
  note?: string;
}

export type ControlOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: string; gate?: GateResult | "busy" | "changed" };

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
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
  private readonly bridge: RoomBridge | null;
  private readonly socketPath: string | null;
  private readonly bootstrap: boolean;
  private readonly dataDir: string | null;
  private readonly gate: HumanGate;
  private readonly stateDir: string | null;
  private readonly gateTimeoutMs: number;
  private gateBusy = false;
  /** This daemon's delivery tokens; only hashes are stored. */
  private readonly deliveryTokens = new Map<string, { generation: number; token: string; address: string }>();
  /** Envelope text is kept in memory only, never in the journal. */
  private readonly intakeText = new Map<string, string>();
  private readonly draining = new Map<string, Promise<void>>();
  private readonly recoveryRefused = new Set<string>();
  private readonly sessionsStarted = new Set<string>();
  /** Bumped by every state a generation's own events report, so a late submit result never overrides it. */
  private readonly stateVersion = new Map<string, number>();
  private readonly activeTurn = new Map<string, string>();
  /** Workers whose last probe could not be read get no input until it reads alive. */
  private readonly probeUnknown = new Set<string>();
  private shuttingDown = false;
  private readonly pendingStarts = new Map<string, { controller: AbortController; done: Promise<void> }>();

  constructor(options: SupervisorOptions) {
    this.store = options.store;
    this.adapters = options.adapters;
    this.processLiveness = options.processLiveness;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
    this.tickWaitMs = options.tickWaitMs ?? TICK_WAIT_MS;
    this.bridge = options.bridge ?? null;
    this.socketPath = options.socketPath ?? null;
    this.bootstrap = options.bootstrap ?? false;
    this.dataDir = options.dataDir ?? null;
    this.gate = options.gate ?? LOCKED_GATE;
    this.stateDir = options.stateDir ?? null;
    this.gateTimeoutMs = options.gateTimeoutMs ?? GATE_TIMEOUT_MS;
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
    // A daemon crash must not silently lose enrolment between reserving it
    // and writing it, or replay a possibly accepted bootstrap prompt.
    for (const row of this.store.db.prepare<[], { worker_id: string }>(`SELECT DISTINCT b.worker_id
      FROM bootstrap_sessions b JOIN inputs i ON i.input_id = b.input_id
      JOIN generations g ON g.worker_id = b.worker_id AND g.session_id = b.session_id
      JOIN workers w ON w.worker_id = b.worker_id
      WHERE (i.state != 'completed' OR i.turn_outcome != 'success') AND w.fresh_next = 0
        AND g.generation = (SELECT MAX(generation) FROM generations WHERE worker_id = b.worker_id)`).all()) {
      this.store.hold(row.worker_id, "bootstrap_failed", this.at());
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
      if (liveness === "unknown") this.probeUnknown.add(worker.worker_id);
      else this.probeUnknown.delete(worker.worker_id);
      this.expireApprovals(worker.worker_id, handle);
      if (liveness === "alive") this.recoverMembership(worker, handle);
      this.bootstrapWorker(handle, worker.worker_id);
      this.drain(worker.worker_id);
      return;
    }
    if (worker.hold_reason || this.starting.has(worker.worker_id)) return;
    if (worker.restart_next) this.store.clearRestart(worker.worker_id);
    if (worker.next_start_at && Date.parse(worker.next_start_at) > this.now().getTime()) return;
    if (this.shuttingDown) return;
    const controller = new AbortController();
    const done = this.start(worker, controller.signal).finally(() => this.pendingStarts.delete(worker.worker_id));
    this.pendingStarts.set(worker.worker_id, { controller, done });
    await done;
  }

  private async start(worker: WorkerRow, signal: AbortSignal): Promise<void> {
    const spec = JSON.parse(worker.spec_json) as WorkerSpec;
    const adapter = this.adapters[spec.harness];
    if (!adapter) {
      this.store.hold(worker.worker_id, "start_failed", this.at());
      return;
    }
    // The configured session seeds only the first start. After that the latest
    // generation decides, including a fresh start that recorded no session.
    const latest = this.store.latestGeneration(worker.worker_id);
    const resume = worker.fresh_next ? undefined
      : latest ? latest.session_id ?? undefined : spec.resume_session_id;
    // Continuing a conversation the adapter cannot resume would quietly start a new one.
    if (resume && !adapter.capabilities().resume) {
      this.store.hold(worker.worker_id, "resume_failed", this.at());
      return;
    }
    // The intent is durable before the spawn, and the child the moment it
    // exists, so a crash at any point leaves evidence and never a duplicate.
    // The intent carries the session it means to resume, so a failed attempt
    // never loses the conversation for the next one.
    const generation = this.store.nextGenerationNumber(worker.worker_id);
    // Only a worker that can take a prompt gets a supervisor endpoint.
    const supervised = this.bridge && this.socketPath && adapter.capabilities().prompt
      ? { token: randomBytes(24).toString("base64url"), address: `${this.socketPath}#${worker.worker_id}@${generation}` }
      : null;
    this.store.recordGeneration({ worker_id: worker.worker_id, generation, pid: null, process_started_at: null,
      pgid: null, session_id: resume ?? null, state: "starting", started_at: this.at(),
      delivery_token_hash: supervised ? hashToken(supervised.token) : null });
    this.starting.add(worker.worker_id);
    let handle: WorkerHandle;
    try {
      handle = await adapter.start({ ...spec, ...(resume ? { resume_session_id: resume } : { resume_session_id: undefined }),
        ...(this.stateDir ? { state_dir: this.stateDir } : {}),
        ...(supervised || this.dataDir ? { supervisor_env: {
          ...(this.dataDir ? { TALKING_STICK_DATA_DIR: this.dataDir } : {}),
          ...(supervised ? { TT_SUPERVISOR_ENDPOINT: supervised.address, TT_SUPERVISOR_TOKEN: supervised.token } : {}) } } : {}) },
        generation, (child) => this.store.updateGeneration(worker.worker_id, generation,
          { pid: child.pid, process_started_at: child.processStartedAt, pgid: child.pgid }), signal);
    } catch (error) {
      this.starting.delete(worker.worker_id);
      if (this.shuttingDown || signal.aborted) {
        this.store.endGeneration(worker.worker_id, generation, this.at(), { reason: "stopped", during: "start" });
        return;
      }
      this.store.endGeneration(worker.worker_id, generation, this.at(), { reason: "start_failed", error: String(error) });
      if (resume) this.store.hold(worker.worker_id, "resume_failed", this.at());
      else this.crashed(worker.worker_id, { reason: "start_failed", error: String(error) });
      return;
    }
    this.starting.delete(worker.worker_id);
    this.store.transaction(() => {
      this.store.updateGeneration(worker.worker_id, generation, { pid: handle.pid, process_started_at: handle.processStartedAt,
        pgid: handle.pgid, session_id: handle.sessionId() ?? resume ?? null, state: "idle" });
      if (worker.fresh_next) this.store.clearFresh(worker.worker_id);
      this.store.audit(this.at(), "supervisor", "start", worker.worker_id, { generation, pid: handle.pid, resumed: Boolean(resume) });
    });
    this.handles.set(worker.worker_id, handle);
    // A start that finished as the daemon stopped is stopped straight away.
    if (this.shuttingDown || signal.aborted) {
      await this.stopHandle(worker.worker_id, handle);
      return;
    }
    this.reportedState.set(worker.worker_id, "idle");
    this.activeTurn.delete(worker.worker_id);
    this.probeUnknown.delete(worker.worker_id);
    if (supervised) this.deliveryTokens.set(worker.worker_id, { generation, ...supervised });
    handle.onEvent((event) => this.onEvent(worker.worker_id, generation, event));
    // A control change while it started wins: the start was for an older version.
    const current = this.store.worker(worker.worker_id);
    if (!current || current.desired !== "running" || current.desired_version !== worker.desired_version) {
      await this.stopHandle(worker.worker_id, handle);
      return;
    }
    this.bootstrapWorker(handle, worker.worker_id);
  }

  private bootstrapWorker(handle: WorkerHandle, workerId: string): void {
    const session = handle.sessionId();
    const worker = this.store.worker(workerId);
    if (!this.bootstrap || !this.bridge || !this.deliveryTokens.has(workerId) || !session || !worker ||
        this.shuttingDown || this.stopping.has(workerId) || this.probeUnknown.has(workerId) ||
        worker.desired !== "running" || worker.hold_reason || this.reportedState.get(workerId) !== "idle") return;
    const inputId = this.newId();
    if (!this.store.claimBootstrap(workerId, session, inputId, handle.generation, this.at())) return;
    const text = `Use the talking-stick skill (${resolveBundledSkillPath()}/SKILL.md). ` +
      "Join the room for your current working directory with `tt join --json` and read `tt instructions show --json`. " +
      "You have no task yet: use `tt standby --json`, or one `tt wait --park --json` if it cannot self-wake. " +
      "Do not claim the stick or start work; wait for the operator in tt chat.";
    void this.dispatchInput(handle, workerId, inputId, text, "start_turn").then((result) => {
      if (result.outcome === "uncertain" || result.outcome === "rejected") this.store.hold(workerId, "bootstrap_failed", this.at());
    }).catch(() => {
      // Never turn a failed bootstrap into an unjournalled retry.
      if (this.store.db.open) this.store.hold(workerId, "bootstrap_failed", this.at());
    });
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
      this.stateVersion.set(workerId, (this.stateVersion.get(workerId) ?? 0) + 1);
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
        this.activeTurn.set(workerId, event.native_turn_id);
        report("busy", { last_model_activity_at: at });
        break;
      case "turn_completed":
        this.store.completeTurn(workerId, generation, event.native_turn_id, event.outcome, at);
        if (this.activeTurn.get(workerId) === event.native_turn_id) this.activeTurn.delete(workerId);
        report("idle", { last_model_activity_at: at });
        if (event.outcome !== "success" && this.store.db.prepare(`SELECT 1 FROM inputs
          WHERE worker_id = ? AND generation = ? AND native_turn_id = ? AND source = 'bootstrap'`)
          .get(workerId, generation, event.native_turn_id)) {
          this.store.hold(workerId, "bootstrap_failed", at);
        }
        this.drain(workerId);
        break;
      case "approval_requested":
        if (!this.store.recordApproval({ approval_id: this.newId(), worker_id: workerId, generation,
          native_request_id: event.native_request_id, tool: displayText(event.tool, 80), summary: displayText(event.summary, 500), detail: safeDetail(event.detail), requested_at: at })) {
          // A second request under a still-pending id is ambiguous: no decision could name it safely.
          this.store.hold(workerId, "protocol_error", at);
          this.stopHandle(workerId, handle).catch(() => {});
          break;
        }
        report("awaiting_approval");
        break;
      case "approval_resolved": {
        // Settled natively: a decision made afterwards can no longer reach it.
        const pending = this.store.pendingApproval(workerId, generation, event.native_request_id);
        if (pending && this.store.settleApproval(pending.approval_id, "expired", "harness", at)) {
          this.store.recordAnswer(pending.approval_id, "failed");
          if (this.reportedState.get(workerId) === "awaiting_approval") report(this.activeTurn.has(workerId) ? "busy" : "idle");
        }
        break;
      }
      case "state":
        report(event.state);
        break;
      case "resume_failed":
        report("disconnected");
        this.store.hold(workerId, "resume_failed", at);
        break;
      case "request_refused":
        this.store.audit(at, "supervisor", "native_request_refused", workerId, { generation,
          method: event.method.replace(/[^A-Za-z0-9/_-]/g, "?").slice(0, 160) });
        break;
      case "protocol_error":
        this.store.hold(workerId, "protocol_error", at);
        this.stopHandle(workerId, handle).catch(() => {});
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
    if (this.deliveryTokens.get(workerId)?.generation === handle.generation) this.deliveryTokens.delete(workerId);
    const { uncertain } = this.store.endGeneration(workerId, handle.generation, this.at(), exit);
    this.store.audit(this.at(), "supervisor", "exit", workerId, { generation: handle.generation, ...exit, uncertain });
    const worker = this.store.worker(workerId);
    if (!worker?.fresh_next && this.store.db.prepare(`SELECT 1 FROM inputs WHERE worker_id = ? AND generation = ?
      AND source = 'bootstrap' AND (state != 'completed' OR turn_outcome != 'success')`)
      .get(workerId, handle.generation)) this.store.hold(workerId, "bootstrap_failed", this.at());
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

  /**
   * tt hands this daemon an envelope for a worker it owns. It is journalled
   * under its batch token before the answer, so queued means durably
   * received, never that a turn started. A batch already journalled answers
   * queued again without a second copy.
   */
  acceptIntake(message: IntakeMessage): IntakeAnswer {
    const handle = this.handles.get(message.worker_id);
    const worker = this.store.worker(message.worker_id);
    const row = handle ? this.store.generation(message.worker_id, handle.generation) : null;
    if (!handle || !worker || !row || handle.generation !== message.generation) return { outcome: "failed", error: "stale_generation" };
    if (!row.delivery_token_hash || row.delivery_token_hash !== hashToken(message.token)) return { outcome: "failed", error: "bad_token" };
    if (worker.desired !== "running" || worker.hold_reason || this.stopping.has(message.worker_id)) {
      return { outcome: "failed", error: "not_running" };
    }
    const spec = JSON.parse(worker.spec_json) as WorkerSpec;
    if (!this.adapters[spec.harness]?.capabilities().prompt) return { outcome: "failed", error: "unsupported" };
    if (this.store.inputForBatch(message.batch_token)) return { outcome: "queued" };
    const inputId = this.newId();
    this.store.journalInput({ input_id: inputId, worker_id: message.worker_id, generation: handle.generation, mode: "start_turn",
      source: "tt_envelope", batch_token: message.batch_token, created_at: this.at() });
    this.intakeText.set(inputId, message.text);
    this.drain(message.worker_id);
    return { outcome: "queued" };
  }

  /** Writes journalled envelopes in order, one at a time per worker. */
  private drain(workerId: string): void {
    if (!this.bridge) return;
    const previous = this.draining.get(workerId) ?? Promise.resolve();
    const next = previous.then(() => this.drainOnce(workerId)).catch(() => {});
    this.draining.set(workerId, next);
  }

  private async drainOnce(workerId: string): Promise<void> {
    for (;;) {
      const handle = this.handles.get(workerId);
      const worker = this.store.worker(workerId);
      const token = this.deliveryTokens.get(workerId);
      if (!handle || !worker || !token || token.generation !== handle.generation || !this.bridge) return;
      if (worker.desired !== "running" || worker.hold_reason || this.stopping.has(workerId) || this.probeUnknown.has(workerId)) return;
      const input = this.store.nextIntake(workerId, handle.generation);
      if (!input) return;
      const text = this.intakeText.get(input.input_id);
      const spec = JSON.parse(worker.spec_json) as WorkerSpec;
      const state = this.reportedState.get(workerId) ?? "idle";
      // An idle worker starts a turn, and only a Codex turn known to be running
      // is steered. An approval or input wait, or an unknown, disconnected or
      // unauthenticated worker, gets nothing until its state changes.
      const busy = state === "busy";
      if (!(state === "idle" || (busy && spec.harness === "codex" && this.activeTurn.has(workerId)))) return;
      const fence = (transition: "writing" | "written" | "unsent") => this.bridge!.fence({ endpoint_address: token.address,
        delivery_secret: token.token, batch_token: input.batch_token!, transition });
      // Fenced before any byte is written; a refused fence means nothing was.
      try {
        if (!text) throw new SupervisorError("The envelope's text is gone.");
        fence("writing");
      } catch (error) {
        this.store.updateInput(input.input_id, workerId, handle.generation, "rejected", this.at());
        this.store.audit(this.at(), "supervisor", "intake_refused", workerId, { batch_token: input.batch_token, error: String(error) });
        this.intakeText.delete(input.input_id);
        continue;
      }
      this.store.setInputMode(input.input_id, busy ? "steer" : "start_turn");
      this.store.updateInput(input.input_id, workerId, handle.generation, "dispatching", this.at());
      const version = this.stateVersion.get(workerId) ?? 0;
      let outcome: InputOutcome;
      try {
        outcome = await handle.submit({ input_id: input.input_id, text, mode: busy ? "steer" : "start_turn" });
      } catch {
        outcome = "uncertain";
      }
      this.intakeText.delete(input.input_id);
      this.store.updateInput(input.input_id, workerId, handle.generation, outcome, this.at());
      // Written or not, the room keeps the fence until the model's tt ack or an
      // operator's reconcile: a write cannot be proven unwritten afterwards.
      if (outcome !== "uncertain" && outcome !== "rejected") {
        try { fence("written"); } catch (error) {
          this.store.audit(this.at(), "supervisor", "fence_written_failed", workerId, { batch_token: input.batch_token, error: String(error) });
        }
      }
      // Until the worker reports its turn, assume one started; a state it
      // already reported while the write was in flight is newer and stands.
      if ((outcome === "accepted" || outcome === "written") && !busy && (this.stateVersion.get(workerId) ?? 0) === version) {
        this.reportedState.set(workerId, "busy");
      }
    }
  }

  /**
   * An owned worker whose harness reported its session ended, though its
   * process runs on, is rejoined through the room's authorized recovery, with
   * its own credential and exact process. It writes no presence beyond that
   * join, sends no prompt, and stops at member_revoked.
   */
  private recoverMembership(worker: WorkerRow, handle: WorkerHandle): void {
    const token = this.deliveryTokens.get(worker.worker_id);
    const session = handle.sessionId();
    if (!this.bridge || !token || token.generation !== handle.generation || !session) return;
    const spec = JSON.parse(worker.spec_json) as WorkerSpec;
    // A resumed generation of a session that has memberships to recover has
    // started it, as observed through the protocol: record that once.
    const startKey = `${worker.worker_id}\u0000${handle.generation}`;
    if (!this.sessionsStarted.has(startKey) && this.bridge.lostSessions({ harness: spec.harness, session_id: session }).length) {
      this.sessionsStarted.add(startKey);
      this.bridge.sessionStarted({ harness: spec.harness, session_id: session, pid: handle.pid, process_started_at: handle.processStartedAt });
    }
    const result = this.bridge.recover({ harness: spec.harness, session_id: session, pid: handle.pid,
      process_started_at: handle.processStartedAt, endpoint_address: token.address, delivery_secret: token.token });
    for (const agentId of result.recovered) this.store.audit(this.at(), "supervisor", "recovered_membership", worker.worker_id, { agent_id: agentId });
    for (const refused of result.refused) {
      const key = `${worker.worker_id}\u0000${handle.generation}\u0000${refused.agent_id}\u0000${refused.error}`;
      if (this.recoveryRefused.has(key)) continue;
      this.recoveryRefused.add(key);
      this.store.audit(this.at(), "supervisor", "recovery_refused", worker.worker_id, refused);
    }
  }

  /**
   * The daemon is stopping: each worker's process group is stopped. Their
   * generations end as stopped, not crashed, and nothing is restarted.
   */
  async shutdown(waitMs = STOP_GRACE_MS): Promise<void> {
    this.shuttingDown = true;
    // Pending starts are cancelled and waited for, so no child outlives the daemon.
    for (const pending of this.pendingStarts.values()) pending.controller.abort();
    await bounded(Promise.allSettled([...this.pendingStarts.values()].map((pending) => pending.done)), waitMs);
    await Promise.allSettled([...this.handles.entries()].map(([workerId, handle]) => this.stopHandle(workerId, handle)));
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
    return this.dispatchInput(handle, workerId, inputId, text, mode);
  }

  private async dispatchInput(handle: WorkerHandle, workerId: string, inputId: string, text: string, mode: InputMode): Promise<{ input_id: string; outcome: InputOutcome }> {
    const generation = handle.generation;
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

  /**
   * The only way a control request takes effect. The control token admitted
   * the caller, which proves nothing about a human; the gate must confirm this
   * exact request. The request is checked before the gate asks and again after
   * it answers, so a confirmation never applies to anything that changed.
   */
  async control(request: ControlRequest): Promise<ControlOutcome> {
    // Without a verified gate nothing is asked or checked: every request is refused.
    if (this.gate === LOCKED_GATE) {
      this.store.audit(this.at(), request.actor, `control_${request.action}_refused`, request.worker_id ?? null,
        { approval_id: request.approval_id ?? null, reason: "control_locked" });
      return { ok: false, error: CONTROL_LOCKED_ERROR, gate: "unavailable" };
    }
    // The note goes to the worker as typed, so the human must be able to read all of it.
    if (request.note !== undefined && (request.note.length > 300 || displayText(request.note, 301) !== request.note)) {
      return { ok: false, error: "A note is plain text of at most 300 characters." };
    }
    const target = this.controlTarget(request);
    if ("error" in target) return { ok: false, error: target.error };
    // One question at a time: a second request can't ride on, or bury, the first.
    if (this.gateBusy) {
      this.store.audit(this.at(), request.actor, `control_${request.action}_busy`, target.gate.worker_id, { ...target.gate });
      return { ok: false, error: "Another control request is waiting for confirmation.", gate: "busy" };
    }
    this.gateBusy = true;
    const signal = AbortSignal.timeout(this.gateTimeoutMs);
    // A gate that fails or never answers is a refusal, never a pass. The next
    // question waits until this one has really ended, so no dialog outlives it.
    const confirming = Promise.resolve().then(() => this.gate.confirm(target.gate, signal)).catch((): GateResult => "refused");
    void confirming.finally(() => { this.gateBusy = false; });
    const result = await Promise.race([confirming,
      new Promise<GateResult>((resolve) => signal.addEventListener("abort", () => resolve("refused"), { once: true }))]);
    this.store.audit(this.at(), request.actor, `control_${request.action}_${result}`, target.gate.worker_id,
      { ...target.gate, gate: this.gate.kind });
    if (result === "unavailable") return { ok: false, error: CONTROL_LOCKED_ERROR, gate: result };
    if (result !== "confirmed") return { ok: false, error: "The human gate did not confirm this request.", gate: result };
    // What was confirmed must still be exactly what is there.
    const again = this.controlTarget(request);
    if ("error" in again || again.handle !== target.handle || JSON.stringify(again.gate) !== JSON.stringify(target.gate)) {
      this.store.audit(this.at(), request.actor, `control_${request.action}_changed`, target.gate.worker_id, { ...target.gate });
      return { ok: false, error: "The request changed while it waited for confirmation.", gate: "changed" };
    }
    if (request.action === "interrupt") {
      return { ok: true, result: await this.interrupt(target.gate.worker_id, request.actor, target.gate.native_turn_id) };
    }
    const decision = request.action === "approve" ? "allow" : "deny";
    const answer = await this.decideApproval({ approval_id: target.gate.approval_id!, worker_id: target.gate.worker_id,
      generation: target.gate.generation }, decision, request.actor, request.note);
    return { ok: true, result: { status: decision === "allow" ? "allowed" : "denied", answer } };
  }

  /** The exact live thing a control request names, as the gate will describe it. */
  private controlTarget(request: ControlRequest): { gate: GateRequest; handle: WorkerHandle } | { error: string } {
    if (request.action === "interrupt") {
      const handle = request.worker_id ? this.handles.get(request.worker_id) : undefined;
      if (!request.worker_id || !handle) return { error: "Name a running worker." };
      // An interrupt names the turn running now; if another turn runs by the answer, it applies to nothing.
      const turn = this.activeTurn.get(request.worker_id);
      if (!turn) return { error: "That worker has no running turn." };
      return { handle, gate: { action: "interrupt", worker_id: request.worker_id, generation: handle.generation, native_turn_id: turn } };
    }
    const approval = request.approval_id ? this.store.approval(request.approval_id) : null;
    if (!approval || approval.status !== "pending") return { error: "No such pending approval request." };
    const handle = this.handles.get(approval.worker_id);
    if (!handle || handle.generation !== approval.generation) return { error: "That request's generation is no longer running." };
    // A human decides only on a request they could read whole, and names the digest they read.
    if (!approval.detail || !approval.detail_sha256) return { error: "That request was recorded without its full detail." };
    const named = (request.detail_sha256 ?? "").toLowerCase();
    if (!/^[0-9a-f]{12,64}$/.test(named) || !approval.detail_sha256.startsWith(named)) {
      return { error: "Name the detail digest you reviewed (tt supervisor approvals show)." };
    }
    return { handle, gate: { action: request.action, worker_id: approval.worker_id, generation: approval.generation,
      approval_id: approval.approval_id, tool: approval.tool, summary: approval.summary, detail_sha256: approval.detail_sha256,
      ...(request.note ? { note: request.note } : {}) } };
  }

  async interrupt(workerId: string, actor: string, expectedTurnId?: string): Promise<"interrupted" | "not_busy" | "unsupported"> {
    const handle = this.handles.get(workerId);
    if (!handle) throw new SupervisorError(`Worker ${workerId} is not running.`);
    this.store.audit(this.at(), actor, "interrupt", workerId, { generation: handle.generation, native_turn_id: expectedTurnId ?? null });
    return handle.interrupt(expectedTurnId);
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
