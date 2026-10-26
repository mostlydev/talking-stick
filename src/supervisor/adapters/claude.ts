import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createProcessEvidence } from "../../supervisor-process-evidence.js";
import { createSystemProcessInspector } from "../../process-utils.js";
import { approvalDetail, approvalSummary } from "../approval-detail.js";
import type { Capabilities, HarnessAdapter, InputMode, InputOutcome, SpawnedProcess, WorkerEvent, WorkerHandle, WorkerSpec } from "../adapter.js";
import { spawnManagedProcess, UnsentInputError, workerEnvironment, type ManagedProcess } from "./process.js";

// Claude Code headless: `claude -p` speaking stream-json on stdin and stdout.
// Permission prompts come back as can_use_tool control requests through the
// stdio permission tool; nothing bypasses them.

type Json = Record<string, unknown>;
function object(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function authenticationError(value: unknown): boolean {
  return /invalid api key|please run \/login|not logged in|authentication|unauthori[sz]ed|401/i.test(JSON.stringify(value ?? ""));
}

export interface ClaudeAdapterOptions {
  /** Injectable executable and prefix for deterministic protocol fixtures. */
  command?: string;
  argsPrefix?: string[];
  requestTimeoutMs?: number;
  startTimeoutMs?: number;
}

/** The native Claude Code executable: an explicit absolute path, or the first on PATH, resolved. */
export function resolveClaudeExecutable(env: NodeJS.ProcessEnv): string {
  const explicit = env.CLAUDE_EXECUTABLE;
  if (explicit && !path.isAbsolute(explicit)) throw new Error("CLAUDE_EXECUTABLE must be an absolute executable path.");
  const candidates = explicit ? [explicit] : (env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, "claude"));
  for (const candidate of candidates) {
    try {
      const real = fs.realpathSync(candidate);
      // A version-manager shim is not the process the supervisor can own.
      if (path.basename(real) === "mise" || path.basename(real) === "asdf") continue;
      fs.accessSync(real, fs.constants.X_OK);
      return real;
    } catch { /* Try the next PATH entry. */ }
  }
  throw new Error("Cannot find the Claude Code executable. Set an explicit CLAUDE_EXECUTABLE environment reference to its absolute path.");
}

export class ClaudeAdapter implements HarnessAdapter {
  readonly harness = "claude" as const;
  constructor(private readonly options: ClaudeAdapterOptions = {}) {}
  capabilities(): Capabilities {
    const supported = process.platform !== "win32";
    // Claude takes no input mid-turn (a message sent while busy waits for its own turn), so prompt but no steer.
    return { prompt: supported, resume: supported, interrupt: supported, approvals: supported };
  }

  async start(spec: WorkerSpec, generation: number, onSpawn: (process: SpawnedProcess) => void, signal?: AbortSignal): Promise<WorkerHandle> {
    if (spec.harness !== "claude" || spec.permissions.harness !== "claude") throw new Error("Claude needs explicit Claude permissions.");
    const env = await workerEnvironment(spec);
    if (signal?.aborted) throw new Error("Claude start aborted.");
    // A fresh conversation is given its id up front, so the supervisor knows
    // the session before the first turn; a resume names the recorded one.
    const session = spec.resume_session_id ?? randomUUID();
    const evidence = spec.supervisor_env?.TT_SUPERVISOR_TOKEN && spec.supervisor_env.TT_SUPERVISOR_ENDPOINT && spec.state_dir
      ? createProcessEvidence({ stateDir: spec.state_dir, workerId: spec.worker_id,
        generation, harness: "claude", endpoint: spec.supervisor_env.TT_SUPERVISOR_ENDPOINT,
        token: spec.supervisor_env.TT_SUPERVISOR_TOKEN }) : null;
    if (evidence) env.TT_SUPERVISOR_PROCESS_FILE = evidence.file;
    const args = [...(this.options.argsPrefix ?? []), "-p", "--input-format", "stream-json", "--output-format", "stream-json",
      "--verbose", "--setting-sources", "project,local", "--strict-mcp-config", "--permission-mode", spec.permissions.mode,
      "--permission-prompt-tool", "stdio", ...(spec.model ? ["--model", spec.model] : []),
      ...(spec.resume_session_id ? ["--resume", session] : ["--session-id", session])];
    const handle = new ClaudeHandle(spec, generation, session, this.options);
    try {
      const child = await spawnManagedProcess({ command: this.options.command ?? resolveClaudeExecutable(env), args, cwd: spec.cwd, env, signal,
        onSpawn: (process) => {
          evidence?.record(process);
          onSpawn(process);
        },
        onLine: (line) => handle.receive(line),
        onExit: (code, exitSignal) => {
          evidence?.clear();
          handle.exited(code, exitSignal);
        },
        onOverflow: () => handle.overflow() });
      handle.attach(child);
      await handle.initialize();
      if (signal?.aborted) throw new Error("Claude start aborted.");
      return handle;
    } catch (error) {
      await handle.stop(100).catch(() => {});
      evidence?.clear();
      throw error;
    }
  }
}

interface ControlWaiter { resolve(value: Json): void; reject(error: Error): void; timer: NodeJS.Timeout }

class ClaudeHandle implements WorkerHandle {
  private child: ManagedProcess | null = null;
  private listeners: Array<(event: WorkerEvent) => void> = [];
  private queued: WorkerEvent[] = [];
  private controls = new Map<string, ControlWaiter>();
  private pendingApprovals = new Map<string, Json>();
  /** The input being run, and whether its turn has shown output yet. */
  private turn: { input_id: string; started: boolean; interruptRequested: boolean } | null = null;
  private turnEnds: Array<(outcome: "success" | "error" | "interrupted" | "unconfirmed") => void> = [];
  private closed = false;
  private overflowed = false;
  /** Set once Claude names a session other than this worker's: nothing it says is used after that. */
  private faulted = false;
  readonly generation: number;

  constructor(private readonly spec: WorkerSpec, generation: number, private readonly session: string,
    private readonly options: ClaudeAdapterOptions) {
    this.generation = generation;
  }
  get pid(): number { return this.child!.pid; }
  get processStartedAt(): string { return this.child!.processStartedAt; }
  get pgid(): number { return this.child!.pgid; }
  sessionId(): string | null { return this.session; }
  attach(child: ManagedProcess): void { this.child = child; }
  onEvent(listener: (event: WorkerEvent) => void): void {
    this.listeners.push(listener);
    for (const event of this.queued.splice(0)) listener(event);
  }
  private emit(event: WorkerEvent): void {
    if (this.listeners.length) { for (const listener of this.listeners) listener(event); }
    else if (this.queued.length < 64) this.queued.push(event);
    else this.overflow();
  }
  overflow(): void {
    if (this.overflowed) return;
    this.overflowed = true;
    this.queued = [{ type: "overflow" }];
    for (const listener of this.listeners) listener({ type: "overflow" });
    this.failControls();
    void this.child?.stop(100).catch(() => {});
  }

  private control(request: Json, timeoutMs: number): Promise<Json> {
    if (!this.child?.alive()) return Promise.reject(new UnsentInputError("Claude is not connected."));
    const id = `tt-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.controls.delete(id); reject(new Error("Claude control request is unconfirmed.")); }, timeoutMs);
      this.controls.set(id, { resolve, reject, timer });
      this.child!.write(JSON.stringify({ type: "control_request", request_id: id, request })).catch((error) => {
        const waiter = this.controls.get(id);
        if (!waiter) return;
        clearTimeout(timer);
        this.controls.delete(id);
        reject(error instanceof UnsentInputError ? error : new Error("Claude control write is unconfirmed."));
      });
    });
  }
  private failControls(): void {
    for (const waiter of this.controls.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("Claude connection ended.")); }
    this.controls.clear();
  }

  async initialize(): Promise<void> {
    const response = await this.control({ subtype: "initialize" }, this.options.startTimeoutMs ?? 15_000);
    if (response.subtype !== "success") throw new Error("Claude did not initialize the session.");
    this.emit({ type: "session", session_id: this.session });
  }

  receive(line: string): void {
    if (this.faulted) return;
    let message: Json;
    try { message = object(JSON.parse(line)); } catch { this.overflow(); return; }
    const type = message.type;
    // Claude names its session at each turn's init and result; any other session is a fault.
    const init = type === "system" && message.subtype === "init";
    if ((init || type === "result") && (message.session_id !== undefined || init) && message.session_id !== this.session) {
      this.fault();
      return;
    }
    if (type === "control_response") {
      const response = object(message.response);
      const id = typeof response.request_id === "string" ? response.request_id : null;
      const waiter = id ? this.controls.get(id) : undefined;
      if (!waiter || !id) return;
      clearTimeout(waiter.timer);
      this.controls.delete(id);
      // A raw error can carry user or auth data; keep only its kind.
      if (response.subtype === "success") waiter.resolve({ subtype: "success", ...object(response.response) });
      else waiter.reject(new Error("Claude rejected the control request."));
      return;
    }
    if (type === "control_request") { this.request(message); return; }
    if (type === "control_cancel_request") {
      const id = typeof message.request_id === "string" ? message.request_id : null;
      if (id && this.pendingApprovals.delete(id)) this.emit({ type: "approval_resolved", native_request_id: id });
      return;
    }
    if (type === "result") { this.finish(message); return; }
    // Any other output belongs to the running turn: its first sign is the start.
    if (this.turn && !this.turn.started && (type === "system" || type === "assistant" || type === "user" || type === "stream_event")) {
      this.turn.started = true;
      this.emit({ type: "turn_started", native_turn_id: this.turn.input_id, input_id: this.turn.input_id });
    }
  }

  private request(message: Json): void {
    const id = typeof message.request_id === "string" ? message.request_id : null;
    const request = object(message.request);
    if (!id) return;
    if (request.subtype !== "can_use_tool") {
      // Only permission prompts are supported; anything else is refused at once.
      this.emit({ type: "request_refused", method: String(request.subtype ?? "unknown") });
      void this.child?.write(JSON.stringify({ type: "control_response",
        response: { subtype: "error", request_id: id, error: "This managed adapter does not support that request." } })).catch(() => {});
      return;
    }
    if (this.pendingApprovals.size >= 32 || this.pendingApprovals.has(id)) { this.overflow(); return; }
    const tool = typeof request.tool_name === "string" ? request.tool_name : "tool";
    const input = object(request.input);
    // The detail is the very input an allow sends back, so what a human reads is what runs.
    const detail = approvalDetail({ tool_name: tool, input });
    if (detail === null) {
      // Too large to review whole, so it is never put to a human.
      this.emit({ type: "request_refused", method: "can_use_tool" });
      void this.child?.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: id,
        response: { behavior: "deny", message: "This request is too large for the operator to review." } } })).catch(() => {});
      return;
    }
    this.pendingApprovals.set(id, input);
    const text = typeof input.command === "string" ? input.command : typeof request.description === "string" ? request.description : JSON.stringify(input);
    this.emit({ type: "approval_requested", native_request_id: id, tool, summary: approvalSummary(text), detail });
  }

  /** Holds the worker and ends it, leaving any running input unconfirmed. */
  private fault(): void {
    this.faulted = true;
    this.emit({ type: "protocol_error" });
    this.failControls();
    void this.child?.stop(100).catch(() => {});
  }

  private finish(message: Json): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    // Claude ends an interrupted turn as an aborted stream; any other failure is an error.
    const outcome = message.subtype === "success" && message.is_error !== true ? "success"
      : turn.interruptRequested && message.terminal_reason === "aborted_streaming" ? "interrupted" : "error";
    if (!turn.started) this.emit({ type: "turn_started", native_turn_id: turn.input_id, input_id: turn.input_id });
    // An approval the turn ended with was settled by the harness.
    for (const id of this.pendingApprovals.keys()) this.emit({ type: "approval_resolved", native_request_id: id });
    this.pendingApprovals.clear();
    this.emit({ type: "turn_completed", native_turn_id: turn.input_id, outcome });
    for (const done of this.turnEnds.splice(0)) done(outcome);
    if (outcome !== "success" && authenticationError(message.result ?? message.errors)) this.emit({ type: "state", state: "auth_required" });
  }

  async submit(input: { input_id: string; text: string; mode: InputMode }): Promise<InputOutcome> {
    // A message sent while Claude is busy would wait for its own turn, so a
    // steer is refused, and so is a second turn while one runs.
    if (this.closed || input.mode === "steer" || this.turn) return "rejected";
    this.turn = { input_id: input.input_id, started: false, interruptRequested: false };
    try {
      await this.child!.write(JSON.stringify({ type: "user", message: { role: "user", content: input.text } }));
    } catch (error) {
      if (!(error instanceof UnsentInputError)) return "uncertain";
      // Only input proven unsent frees the turn; otherwise it is Claude's until its result or exit.
      this.turn = null;
      return "rejected";
    }
    this.emit({ type: "input", input_id: input.input_id, outcome: "written" });
    return "written";
  }

  async interrupt(expectedTurnId?: string): Promise<"interrupted" | "not_busy" | "unsupported"> {
    const turn = this.turn;
    if (!turn || (expectedTurnId !== undefined && turn.input_id !== expectedTurnId)) return "not_busy";
    turn.interruptRequested = true;
    // Waits for the turn's end before asking, since its result can arrive before the reply.
    let timer: NodeJS.Timeout | undefined;
    let waiter: (value: "success" | "error" | "interrupted" | "unconfirmed") => void = () => {};
    const forget = () => {
      clearTimeout(timer);
      const index = this.turnEnds.indexOf(waiter);
      if (index >= 0) this.turnEnds.splice(index, 1);
    };
    const ended = new Promise<string>((resolve) => {
      waiter = (value) => { clearTimeout(timer); resolve(value); };
      timer = setTimeout(() => { forget(); resolve("unconfirmed"); }, this.options.requestTimeoutMs ?? 10_000);
      this.turnEnds.push(waiter);
    });
    try {
      await this.control({ subtype: "interrupt" }, this.options.requestTimeoutMs ?? 10_000);
    } catch {
      forget();
      if (this.turn === turn) turn.interruptRequested = false;
      return "unsupported";
    }
    const outcome = await ended;
    return outcome === "interrupted" ? "interrupted" : outcome === "success" ? "not_busy" : "unsupported";
  }

  async answerApproval(id: string, decision: "allow" | "deny", note?: string): Promise<void> {
    const input = this.pendingApprovals.get(id);
    if (!input || this.closed) throw new Error("That native approval is no longer pending.");
    this.pendingApprovals.delete(id);
    await this.child!.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: id,
      response: decision === "allow" ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: note ?? "Denied by the operator." } } }));
  }

  async probe(): Promise<"alive" | "gone" | "unknown"> {
    if (!this.child?.alive()) return "gone";
    const inspection = createSystemProcessInspector().inspect(this.pid);
    if (!inspection) return inspection === null ? "gone" : "unknown";
    if (inspection.startTime?.trim() !== this.processStartedAt) return inspection.startTime ? "gone" : "unknown";
    // Claude's stream has no cheap ping, so liveness is the exact process.
    return "alive";
  }

  exited(code: number | null, signal: string | null): void {
    if (this.closed) return;
    this.closed = true;
    this.failControls();
    this.pendingApprovals.clear();
    for (const done of this.turnEnds.splice(0)) done("unconfirmed");
    this.emit({ type: "exited", code, signal });
  }

  async stop(graceMs: number): Promise<void> {
    await this.child?.stop(graceMs);
    this.failControls();
  }
}
