import fs from "node:fs";
import path from "node:path";
import { createProcessEvidence } from "../../supervisor-process-evidence.js";
import { createSystemProcessInspector } from "../../process-utils.js";
import { AuthModeError, type Capabilities, type HarnessAdapter, type InputOutcome, type SpawnedProcess, type WorkerEvent, type WorkerHandle, type WorkerSpec } from "../adapter.js";
import { spawnManagedProcess, UnsentInputError, workerEnvironment, type ManagedProcess } from "./process.js";

// Antigravity headless: `agy --input-format stream-json --output-format stream-json`,
// without --print. Each prompt is one stdin line
// {"event":"user","message":{"content":"..."}}. The CLI rejects control_request
// and control_response, so this adapter never answers a permission. Unapproved
// tools are soft-denied by agy. Resume is a new process with --conversation.

type Json = Record<string, unknown>;
function object(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function authenticationError(value: unknown): boolean {
  return /authentication required|not logged|unauth|401/i.test(String(value ?? ""));
}

export interface AgyAdapterOptions {
  command?: string;
  argsPrefix?: string[];
  startTimeoutMs?: number;
}

export function resolveAgyExecutable(env: NodeJS.ProcessEnv): string {
  const explicit = env.AGY_EXECUTABLE;
  if (explicit && !path.isAbsolute(explicit)) throw new Error("AGY_EXECUTABLE must be an absolute executable path.");
  const candidates = explicit ? [explicit] : (env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, "agy"));
  for (const candidate of candidates) {
    try {
      const real = fs.realpathSync(candidate);
      if (path.basename(real) === "mise" || path.basename(real) === "asdf") continue;
      fs.accessSync(real, fs.constants.X_OK);
      return real;
    } catch { /* Try the next PATH entry. */ }
  }
  throw new Error("Cannot find the agy executable. Set an explicit AGY_EXECUTABLE environment reference to its absolute path.");
}

export class AgyAdapter implements HarnessAdapter {
  readonly harness = "agy" as const;
  constructor(private readonly options: AgyAdapterOptions = {}) {}
  capabilities(): Capabilities {
    return { prompt: true, resume: true, interrupt: false, approvals: false };
  }

  async start(spec: WorkerSpec, generation: number, onSpawn: (process: SpawnedProcess) => void, signal?: AbortSignal): Promise<WorkerHandle> {
    if (spec.harness !== "agy" || spec.permissions.harness !== "agy") throw new Error("agy needs explicit agy permissions.");
    const env = workerEnvironment(spec);
    if (signal?.aborted) throw new Error("agy start aborted.");
    const stateDir = spec.state_dir;
    if (!stateDir) throw new Error("A managed agy worker needs the supervisor's state directory.");
    const token = spec.supervisor_env?.TT_SUPERVISOR_TOKEN;
    const endpoint = spec.supervisor_env?.TT_SUPERVISOR_ENDPOINT;
    const evidence = token && endpoint ? createProcessEvidence({ stateDir, workerId: spec.worker_id,
      generation, harness: "agy", endpoint, token }) : null;
    if (evidence) env.TT_SUPERVISOR_PROCESS_FILE = evidence.file;
    const handle = new AgyHandle(this.options, generation, spec.resume_session_id);
    const args = [...(this.options.argsPrefix ?? []), "--input-format", "stream-json", "--output-format", "stream-json"];
    if (spec.resume_session_id) args.push("--conversation", spec.resume_session_id);
    try {
      const child = await spawnManagedProcess({
        command: this.options.command ?? resolveAgyExecutable(env),
        args, cwd: spec.cwd, env, signal,
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
      await handle.opened(signal);
      if (signal?.aborted) throw new Error("agy start aborted.");
      return handle;
    } catch (error) {
      await handle.stop(100).catch(() => {});
      evidence?.clear();
      throw error;
    }
  }
}

class AgyHandle implements WorkerHandle {
  private child: ManagedProcess | null = null;
  private session: string | null = null;
  private listeners: Array<(event: WorkerEvent) => void> = [];
  private queued: WorkerEvent[] = [];
  private closed = false;
  private overflowed = false;
  private busy = false;
  private pendingInput: string | null = null;
  private openWait: { resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout } | null = null;
  readonly generation: number;
  constructor(private readonly options: AgyAdapterOptions, generation: number, private readonly expectedSession?: string) {
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
    void this.child?.stop(100).catch(() => {});
  }
  opened(signal?: AbortSignal): Promise<void> {
    const timeout = this.options.startTimeoutMs ?? 15_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.openWait = null;
        reject(new Error("agy did not send init."));
      }, timeout);
      const onAbort = () => {
        clearTimeout(timer);
        this.openWait = null;
        reject(new Error("agy start aborted."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.openWait = {
        resolve: () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolve(); },
        reject: (error) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(error); },
        timer
      };
    });
  }
  receive(line: string): void {
    if (this.closed || this.overflowed) return;
    let message: Json;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) { this.overflow(); return; }
      message = parsed as Json;
    } catch { this.overflow(); return; }
    const event = message.event;
    if (event === "init") {
      const id = typeof message.conversation_id === "string" ? message.conversation_id : "";
      if (!id || (this.expectedSession && id !== this.expectedSession)) {
        this.openWait?.reject(new Error("agy named another conversation."));
        this.openWait = null;
        this.emit({ type: "protocol_error" });
        return;
      }
      this.session = id;
      this.emit({ type: "session", session_id: id });
      this.emit({ type: "state", state: "idle" });
      this.openWait?.resolve();
      this.openWait = null;
      return;
    }
    if (event === "step_update") {
      const step = object(message.step_update);
      if (step.step_type === "user_input" && step.state === "DONE" && this.pendingInput) {
        this.emit({ type: "turn_started", native_turn_id: this.pendingInput, input_id: this.pendingInput });
      }
      return;
    }
    if (event === "result") {
      const result = object(message.result);
      const status = typeof result.status === "string" ? result.status : "";
      const inputId = this.pendingInput;
      this.pendingInput = null;
      this.busy = false;
      if (authenticationError(result.error)) {
        this.emit({ type: "state", state: "auth_required" });
        this.openWait?.reject(new AuthModeError("auth_required", "agy authentication required."));
        this.openWait = null;
        return;
      }
      if (inputId) {
        this.emit({ type: "turn_completed", native_turn_id: inputId, outcome: status === "SUCCESS" ? "success" : "error" });
      }
      this.emit({ type: "state", state: "idle" });
    }
  }
  async submit(input: { input_id: string; text: string }): Promise<InputOutcome> {
    if (this.closed || this.overflowed || !this.child?.alive() || !this.session || this.busy) return "rejected";
    this.busy = true;
    this.pendingInput = input.input_id;
    try {
      await this.child.write(JSON.stringify({ event: "user", message: { content: input.text } }));
    } catch (error) {
      this.busy = false;
      this.pendingInput = null;
      if (error instanceof UnsentInputError) return "rejected";
      return "uncertain";
    }
    return "accepted";
  }
  async interrupt(): Promise<"interrupted" | "not_busy" | "unsupported"> {
    return "unsupported";
  }
  async answerApproval(): Promise<void> {
    throw new Error("agy approvals are not available. The CLI rejects control responses.");
  }
  async probe(): Promise<"alive" | "gone" | "unknown"> {
    if (this.closed || !this.child?.alive()) return "gone";
    const inspection = createSystemProcessInspector().inspect(this.pid);
    if (!inspection) return "gone";
    if (inspection.startTime?.trim() !== this.processStartedAt) return inspection.startTime ? "gone" : "unknown";
    return this.session && !this.overflowed ? "alive" : "unknown";
  }
  exited(code: number | null, signal: string | null): void {
    if (this.closed) return;
    this.closed = true;
    this.openWait?.reject(new Error("agy exited before init."));
    this.openWait = null;
    this.emit({ type: "exited", code, signal });
  }
  async stop(graceMs: number): Promise<void> {
    await this.child?.stop(graceMs);
  }
}
