import fs from "node:fs";
import path from "node:path";
import { createProcessEvidence } from "../../supervisor-process-evidence.js";
import { createSystemProcessInspector } from "../../process-utils.js";
import type { Capabilities, HarnessAdapter, InputOutcome, SpawnedProcess, WorkerEvent, WorkerHandle, WorkerSpec } from "../adapter.js";
import { spawnManagedProcess, UnsentInputError, workerEnvironment, type KeychainReader, type ManagedProcess } from "./process.js";

// Grok headless: `grok agent --no-leader stdio`. Prompt, resume, interrupt and
// approvals are unproven, so all four stay false on every platform. The child
// gets a private GROK_HOME and never the user's config, which may always-approve.

type Json = Record<string, unknown>;
function object(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

class RpcError extends Error {
  constructor(message: string) { super(message); }
}

function authenticationError(value: unknown): boolean {
  return /unauth|authentication|not logged|401|login required/i.test(JSON.stringify(value ?? {}));
}

/** One JSON-RPC connection to the Grok process this handle owns. */
class Rpc {
  process: ManagedProcess | null = null;
  private id = 0;
  private pending = new Map<number, { resolve(value: Json): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  request(method: string, params: Json, timeoutMs: number): Promise<Json> {
    if (!this.process?.alive()) return Promise.reject(new RpcError("Grok is not connected."));
    if (this.pending.size >= 64) return Promise.reject(new RpcError("Grok has too many pending requests."));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError("Grok request is unconfirmed."));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.process!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params })).catch((error) => {
        const waiting = this.pending.get(id);
        if (!waiting) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof UnsentInputError ? new RpcError("Grok request was not sent.") : new RpcError("Grok write is unconfirmed."));
      });
    });
  }
  complete(message: Json): void {
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error !== undefined) {
      // A raw server error can carry user or auth data; keep only its kind.
      pending.reject(new RpcError(authenticationError(message.error) ? "Grok authentication failed." : "Grok rejected the protocol request."));
    } else if (message.result !== undefined) pending.resolve(object(message.result));
    else pending.reject(new RpcError("Grok returned an invalid response."));
  }
  close(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RpcError("Grok connection ended."));
    }
    this.pending.clear();
  }
}

export interface GrokAdapterOptions {
  /** Injectable executable and prefix for deterministic protocol fixtures. */
  command?: string;
  argsPrefix?: string[];
  startTimeoutMs?: number;
  /** Test double for a Keychain env ref. Production reads the macOS item. */
  readKeychain?: KeychainReader;
}

/** The native `grok` executable: an explicit absolute path, or the first on PATH, resolved. */
export function resolveGrokExecutable(env: NodeJS.ProcessEnv): string {
  const explicit = env.GROK_EXECUTABLE;
  if (explicit && !path.isAbsolute(explicit)) throw new Error("GROK_EXECUTABLE must be an absolute executable path.");
  const candidates = explicit ? [explicit] : (env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, "grok"));
  for (const candidate of candidates) {
    try {
      const real = fs.realpathSync(candidate);
      // A version-manager shim is not the process the supervisor can own.
      if (path.basename(real) === "mise" || path.basename(real) === "asdf") continue;
      fs.accessSync(real, fs.constants.X_OK);
      return real;
    } catch { /* Try the next PATH entry. */ }
  }
  throw new Error("Cannot find the Grok executable. Set an explicit GROK_EXECUTABLE environment reference to its absolute path.");
}

export class GrokAdapter implements HarnessAdapter {
  readonly harness = "grok" as const;
  constructor(private readonly options: GrokAdapterOptions = {}) {}
  capabilities(): Capabilities {
    return { prompt: false, resume: false, interrupt: false, approvals: false };
  }

  async start(spec: WorkerSpec, generation: number, onSpawn: (process: SpawnedProcess) => void, signal?: AbortSignal): Promise<WorkerHandle> {
    if (spec.harness !== "grok" || spec.permissions.harness !== "grok") throw new Error("Grok needs explicit Grok permissions.");
    // Resuming would quietly open some other conversation. The daemon also
    // holds resume_failed before it calls start; this rejects a direct call.
    if (spec.resume_session_id) throw new Error("Grok cannot resume a session yet.");
    const env = await workerEnvironment(spec, process.env, this.options.readKeychain);
    if (signal?.aborted) throw new Error("Grok start aborted.");
    const stateDir = spec.state_dir;
    if (!stateDir) throw new Error("A managed Grok worker needs the supervisor's state directory.");
    // Always this private directory, even when the spec names a GROK_HOME.
    // Nothing is copied into it: the user's config can set always-approve.
    const home = path.join(stateDir, "workers", spec.worker_id, "grok");
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.chmodSync(home, 0o700);
    env.GROK_HOME = home;
    // Prompt is false, so the daemon does not issue an endpoint or token.
    // Evidence is skipped unless both are present.
    const token = spec.supervisor_env?.TT_SUPERVISOR_TOKEN;
    const endpoint = spec.supervisor_env?.TT_SUPERVISOR_ENDPOINT;
    const evidence = token && endpoint ? createProcessEvidence({ stateDir, workerId: spec.worker_id,
      generation, harness: "grok", endpoint, token }) : null;
    if (evidence) env.TT_SUPERVISOR_PROCESS_FILE = evidence.file;
    const handle = new GrokHandle(this.options, generation);
    try {
      const child = await spawnManagedProcess({
        command: this.options.command ?? resolveGrokExecutable(env),
        args: [...(this.options.argsPrefix ?? []), "agent", "--no-leader", "stdio"],
        cwd: spec.cwd, env, signal,
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
      await handle.initialize(spec.cwd);
      if (signal?.aborted) throw new Error("Grok start aborted.");
      return handle;
    } catch (error) {
      await handle.stop(100).catch(() => {});
      evidence?.clear();
      throw error;
    }
  }
}

class GrokHandle implements WorkerHandle {
  private child: ManagedProcess | null = null;
  private readonly rpc = new Rpc();
  private session: string | null = null;
  private listeners: Array<(event: WorkerEvent) => void> = [];
  private queued: WorkerEvent[] = [];
  private closed = false;
  private overflowed = false;
  readonly generation: number;
  constructor(private readonly options: GrokAdapterOptions, generation: number) { this.generation = generation; }
  get pid(): number { return this.child!.pid; }
  get processStartedAt(): string { return this.child!.processStartedAt; }
  get pgid(): number { return this.child!.pgid; }
  sessionId(): string | null { return this.session; }
  attach(child: ManagedProcess): void { this.child = child; this.rpc.process = child; }
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
    this.rpc.close();
    void this.child?.stop(100).catch(() => {});
  }
  receive(line: string): void {
    if (this.closed || this.overflowed) return;
    let message: Json;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) { this.overflow(); return; }
      message = parsed as Json;
    } catch { this.overflow(); return; }
    const method = message.method;
    if (typeof method === "string") {
      // Notifications, including session/update, are not turns. A server
      // request (method and id) is refused; nothing waits for input.
      if (message.id === undefined) return;
      this.emit({ type: "request_refused", method });
      void this.child?.write(JSON.stringify({ jsonrpc: "2.0", id: message.id,
        error: { code: -32601, message: "Method not available." } })).catch((error) => {
        if (!(error instanceof UnsentInputError)) this.overflow();
      });
      return;
    }
    this.rpc.complete(message);
  }
  async initialize(cwd: string): Promise<void> {
    const timeout = this.options.startTimeoutMs ?? 15_000;
    // No fs or terminal capabilities: this worker does not service those.
    await this.rpc.request("initialize", { protocolVersion: 1,
      clientInfo: { name: "talking_stick_supervisor", version: "0" } }, timeout);
    const created = await this.rpc.request("session/new", { cwd, mcpServers: [] }, timeout);
    if (typeof created.sessionId !== "string" || !created.sessionId) throw new Error("Grok did not return a session id.");
    this.session = created.sessionId;
    this.emit({ type: "session", session_id: this.session });
  }
  async submit(): Promise<InputOutcome> {
    return "rejected";
  }
  async interrupt(): Promise<"interrupted" | "not_busy" | "unsupported"> {
    return "unsupported";
  }
  async answerApproval(): Promise<void> {
    throw new Error("Grok approvals are not available.");
  }
  async probe(): Promise<"alive" | "gone" | "unknown"> {
    if (this.closed || !this.child?.alive()) return "gone";
    const inspection = createSystemProcessInspector().inspect(this.pid);
    if (!inspection) return inspection === null ? "gone" : "unknown";
    if (inspection.startTime?.trim() !== this.processStartedAt) return inspection.startTime ? "gone" : "unknown";
    if (!this.session || this.overflowed) return "unknown";
    let listed: Json;
    try {
      listed = await this.rpc.request("session/list", {}, 2_000);
    } catch {
      return this.child?.alive() ? "unknown" : "gone";
    }
    if (!this.child.alive()) return "gone";
    // A live process proves nothing about its session: only this session, listed by id, does.
    // Natively the list is { sessions: [...] }; an empty, other or partial list is no evidence.
    const sessions = Array.isArray(listed.sessions) ? listed.sessions : [];
    return sessions.some((entry) => object(entry).sessionId === this.session) ? "alive" : "unknown";
  }
  exited(code: number | null, signal: string | null): void {
    if (this.closed) return;
    this.closed = true;
    this.rpc.close();
    this.emit({ type: "exited", code, signal });
  }
  async stop(graceMs: number): Promise<void> {
    await this.child?.stop(graceMs);
    this.rpc.close();
  }
}
