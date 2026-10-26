import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createProcessEvidence } from "../../supervisor-process-evidence.js";
import { createSystemProcessInspector } from "../../process-utils.js";
import { approvalDetail, approvalSummary, displayText } from "../approval-detail.js";
import { packageRoot } from "../eligibility.js";
import type { Capabilities, Confinement, HarnessAdapter, InputMode, InputOutcome, SpawnedProcess, WorkerEvent, WorkerHandle, WorkerSpec } from "../adapter.js";
import { spawnManagedProcess, UnsentInputError, workerEnvironment, type ManagedProcess } from "./process.js";

type Json = Record<string, unknown>;
function object(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}
function nativeKey(id: string | number): string { return `${typeof id === "number" ? "n" : "s"}:${id}`; }

class RpcError extends Error {
  constructor(message: string, readonly unsent = false, readonly code?: number, readonly auth = false) { super(message); }
}

function authenticationError(value: unknown): boolean {
  return /unauth|authentication|not logged|401|login required/i.test(JSON.stringify(value ?? {}));
}

/** One JSON-RPC connection to the app-server process this handle owns. */
class Rpc {
  process: ManagedProcess | null = null;
  private id = 0;
  private pending = new Map<number, { resolve(value: Json): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  constructor(private notify: (message: Json) => void) {}
  receive(line: string): void {
    let message: Json;
    try { message = object(JSON.parse(line)); } catch { this.close(); throw new Error("Malformed Codex protocol frame."); }
    if (typeof message.method === "string") { this.notify(message); return; }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(message.id);
    if (message.error) {
      const code = object(message.error).code;
      // Do not retain a raw server error: it can contain user or auth data.
      pending.reject(new RpcError("Codex rejected the protocol request.",
        code === -32600 || code === -32601 || code === -32602, typeof code === "number" ? code : undefined,
        authenticationError(message.error)));
    } else if (message.result !== undefined) pending.resolve(object(message.result));
    else pending.reject(new RpcError("Codex returned an invalid response."));
  }
  request(method: string, params: Json, timeoutMs: number, written?: () => void): Promise<Json> {
    if (!this.process?.alive()) return Promise.reject(new RpcError("Codex is not connected.", true));
    if (this.pending.size >= 64) return Promise.reject(new RpcError("Codex has too many pending requests.", true));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RpcError("Codex request is unconfirmed.")); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.process!.write(JSON.stringify({ id, method, params })).then(written, (error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(timer); this.pending.delete(id);
        reject(new RpcError("Codex write is unconfirmed.", error instanceof UnsentInputError));
      });
    });
  }
  send(message: Json): Promise<void> {
    return this.process?.write(JSON.stringify(message)) ?? Promise.reject(new UnsentInputError("Codex is not connected."));
  }
  close(): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new RpcError("Codex connection ended.")); }
    this.pending.clear();
  }
}

export interface CodexAdapterOptions {
  /** Injectable executable/prefix for deterministic native-protocol fixtures. */
  command?: string;
  argsPrefix?: string[];
  requestTimeoutMs?: number;
  startTimeoutMs?: number;
}

/** Resolve the official npm shim to the native executable, never own its Node wrapper. */
export function resolveCodexExecutable(env: NodeJS.ProcessEnv): string {
  const explicit = env.CODEX_EXECUTABLE;
  if (explicit && !path.isAbsolute(explicit)) throw new Error("CODEX_EXECUTABLE must be an absolute native executable path.");
  const candidates = explicit ? [explicit] : (env.PATH ?? "").split(path.delimiter).filter(Boolean).map(dir => path.join(dir, "codex"));
  const triple = process.platform === "darwin" ? `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`
    : `${process.arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-musl`;
  for (const candidate of candidates) {
    try {
      const real = fs.realpathSync(candidate);
      // Version-manager shims are not the process the supervisor can own.
      if (path.basename(real) === "mise" || path.basename(real) === "asdf") continue;
      const prefix = Buffer.alloc(4);
      const fd = fs.openSync(real, "r");
      try { fs.readSync(fd, prefix, 0, 4, 0); } finally { fs.closeSync(fd); }
      const magic = prefix.toString("hex");
      if (["7f454c46", "cffaedfe", "cefaedfe", "feedfacf", "feedface", "cafebabe"].includes(magic)) {
        fs.accessSync(real, fs.constants.X_OK); return real;
      }
      const root = path.dirname(path.dirname(real));
      const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
      if (manifest.name !== "@openai/codex") continue;
      const platformPackage = `@openai/codex-${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch}`;
      let vendor = path.join(root, "vendor");
      try { vendor = path.join(path.dirname(createRequire(path.join(root, "package.json")).resolve(`${platformPackage}/package.json`)), "vendor"); } catch { /* older bundled layout */ }
      const native = path.join(vendor, triple, "bin", "codex");
      fs.accessSync(native, fs.constants.X_OK);
      return fs.realpathSync(native);
    } catch { /* Try the next PATH entry, without executing an arbitrary shim. */ }
  }
  throw new Error("Cannot find a native Codex executable. Set an explicit CODEX_EXECUTABLE environment reference to its absolute path.");
}

export class CodexAdapter implements HarnessAdapter {
  readonly harness = "codex" as const;
  constructor(private readonly options: CodexAdapterOptions = {}) {}
  capabilities(): Capabilities {
    const supported = process.platform !== "win32";
    return { prompt: supported, resume: supported, interrupt: supported, approvals: supported };
  }
  async start(spec: WorkerSpec, generation: number, onSpawn: (process: SpawnedProcess) => void,
    signal?: AbortSignal): Promise<WorkerHandle> {
    if (spec.harness !== "codex" || spec.permissions.harness !== "codex") throw new Error("Codex needs explicit Codex permissions.");
    const env = await workerEnvironment(spec);
    if (signal?.aborted) throw new Error("Codex start aborted.");
    // No implicit user config, plugins, hooks or approval rules. An operator
    // may explicitly reference a prepared CODEX_HOME; auth is never copied.
    const preparedHome = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : null;
    if (!env.CODEX_HOME) {
      if (!spec.state_dir) throw new Error("A managed Codex worker needs the supervisor's state directory.");
      env.CODEX_HOME = path.join(spec.state_dir, "workers", spec.worker_id, "codex");
    }
    fs.mkdirSync(env.CODEX_HOME, { recursive: true, mode: 0o700 });
    const evidence = spec.supervisor_env?.TT_SUPERVISOR_TOKEN && spec.supervisor_env.TT_SUPERVISOR_ENDPOINT && spec.state_dir
      ? createProcessEvidence({ stateDir: spec.state_dir, workerId: spec.worker_id,
        generation, harness: "codex", endpoint: spec.supervisor_env.TT_SUPERVISOR_ENDPOINT,
        token: spec.supervisor_env.TT_SUPERVISOR_TOKEN }) : null;
    if (evidence) env.TT_SUPERVISOR_PROCESS_FILE = evidence.file;
    const handle = new CodexHandle(spec, generation, this.options, env.CODEX_HOME);
    try {
      const command = this.options.command ?? resolveCodexExecutable(env);
      handle.closure = { command, preparedHome, tmpdir: env.TMPDIR ?? null };
      const child = await spawnManagedProcess({ command,
        args: [...(this.options.argsPrefix ?? []), "app-server", "--listen", "stdio://"], cwd: spec.cwd, env, signal,
        onSpawn: (process) => {
          evidence?.record(process);
          onSpawn(process);
        }, onLine: (line) => handle.receive(line), onExit: (code, exitSignal) => {
          evidence?.clear();
          handle.exited(code, exitSignal);
        },
        onOverflow: () => handle.overflow() });
      handle.attach(child);
      await handle.initialize();
      if (signal?.aborted) throw new Error("Codex start aborted.");
      return handle;
    } catch (error) {
      await handle.stop(100).catch(() => {});
      evidence?.clear();
      throw error;
    }
  }
}

interface PendingApproval { id: string | number; method: string; choices: unknown[] | null; file?: string }

class CodexHandle implements WorkerHandle {
  private child: ManagedProcess | null = null;
  private readonly rpc: Rpc;
  private thread: string | null = null;
  private turn: string | null = null;
  private inputStarting: string | null = null;
  private listeners: Array<(event: WorkerEvent) => void> = [];
  private queued: WorkerEvent[] = [];
  private pendingApprovals = new Map<string, PendingApproval>();
  private turnEnds = new Map<string, Array<(outcome: string) => void>>();
  private completed = new Map<string, "success" | "error" | "interrupted">();
  private closed = false;
  private overflowed = false;
  private authRequired = false;
  private disconnected = false;
  private resumeFailed = false;
  private reloading: Promise<boolean> | null = null;
  private effective: Confinement = { kind: "unconfined", reason: "Codex has not reported its sandbox yet" };
  /** What starts this worker: set before the spawn. */
  closure: { command: string; preparedHome: string | null; tmpdir: string | null } | null = null;
  readonly generation: number;
  constructor(private readonly spec: WorkerSpec, generation: number, private readonly options: CodexAdapterOptions,
    private readonly nativeHome: string) {
    this.generation = generation;
    this.rpc = new Rpc((message) => this.notification(message));
  }
  get pid(): number { return this.child!.pid; }
  get processStartedAt(): string { return this.child!.processStartedAt; }
  get pgid(): number { return this.child!.pgid; }
  sessionId(): string | null { return this.thread; }
  confinement(): Confinement { return this.effective; }
  executionClosure(): { paths: string[]; unresolved: string[] } {
    if (!this.closure) return { paths: [], unresolved: ["its native executable"] };
    const paths = [this.closure.command];
    const root = packageRoot(this.closure.command);
    if (root) paths.push(root);
    // A prepared home's config and hooks run at the next start, outside any tool sandbox.
    if (this.closure.preparedHome) paths.push(this.closure.preparedHome);
    return { paths, unresolved: [] };
  }
  attach(child: ManagedProcess): void { this.child = child; this.rpc.process = child; }
  receive(line: string): void { this.rpc.receive(line); }
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
  async initialize(): Promise<void> {
    const timeout = this.options.startTimeoutMs ?? 15_000;
    await this.rpc.request("initialize", { clientInfo: { name: "talking_stick_supervisor", version: "1" },
      capabilities: { experimentalApi: true } }, timeout);
    await this.rpc.send({ method: "initialized", params: {} });
    await this.openThread(this.spec.resume_session_id);
    await this.checkAuthentication();
  }

  private async openThread(resume?: string): Promise<void> {
    const timeout = this.options.startTimeoutMs ?? 15_000;
    const permissions = this.spec.permissions;
    if (permissions.harness !== "codex") throw new Error("Invalid Codex permission settings.");
    const dataDir = this.spec.supervisor_env?.TALKING_STICK_DATA_DIR;
    const config: Json = { "sandbox_workspace_write.network_access": false };
    if (permissions.sandbox === "workspace-write" && dataDir) config["sandbox_workspace_write.writable_roots"] = [path.resolve(dataDir)];
    const result = await this.rpc.request(resume ? "thread/resume" : "thread/start", {
      ...(resume ? { threadId: resume, excludeTurns: true } : {}),
      cwd: this.spec.cwd, sandbox: permissions.sandbox, approvalPolicy: permissions.approval, config,
      ...(this.spec.model ? { model: this.spec.model } : {}),
      developerInstructions: "You are a managed Talking Stick worker. Use the talking-stick skill for coordination. " +
        "Never change approval or permission settings, adopt another session, or repeat unconfirmed side effects after a crash." }, timeout);
    const thread = object(result.thread);
    const sandbox = object(result.sandbox);
    const expected = permissions.sandbox === "read-only" ? "readOnly" : "workspaceWrite";
    if (typeof thread.id !== "string" || (resume && thread.id !== resume) ||
        result.approvalPolicy !== permissions.approval || sandbox.type !== expected || sandbox.networkAccess === true) {
      throw new Error("Codex did not establish the requested session and permissions.");
    }
    if (expected === "workspaceWrite" && dataDir &&
        !(Array.isArray(sandbox.writableRoots) && sandbox.writableRoots.includes(path.resolve(dataDir)))) {
      throw new Error("Codex did not establish the explicit Talking Stick metadata writable root.");
    }
    if (object(thread.status).type !== "idle") throw new Error("Codex did not establish an idle owned session.");
    this.effective = effectiveConfinement(sandbox, typeof result.cwd === "string" ? result.cwd : this.spec.cwd, this.closure?.tmpdir ?? null);
    this.thread = thread.id;
    this.emit({ type: "session", session_id: this.thread });
  }

  private async checkAuthentication(): Promise<boolean> {
    const result = await this.rpc.request("account/read", { refreshToken: false }, 2_000);
    const missing = result.requiresOpenaiAuth !== false && !result.account;
    if (missing) {
      this.authRequired = true;
      this.emit({ type: "state", state: "auth_required" });
    } else if (this.authRequired) {
      this.authRequired = false;
      if (!this.turn && !this.disconnected) this.emit({ type: "state", state: "idle" });
    }
    return !missing;
  }

  private notification(message: Json): void {
    const method = message.method as string;
    const params = object(message.params);
    if (typeof message.id === "number" || typeof message.id === "string") {
      this.approval(message.id, method, params); return;
    }
    if (params.threadId !== this.thread) return;
    if (method === "turn/started") {
      const id = object(params.turn).id;
      if (typeof id === "string") {
        this.turn = id;
        this.emit({ type: "turn_started", native_turn_id: id, ...(this.inputStarting ? { input_id: this.inputStarting } : {}) });
      }
    } else if (method === "turn/completed") {
      const turn = object(params.turn);
      if (typeof turn.id !== "string") return;
      const outcome = turn.status === "completed" ? "success" : turn.status === "interrupted" ? "interrupted" : "error";
      this.completed.set(turn.id, outcome);
      if (this.completed.size > 64) this.completed.delete(this.completed.keys().next().value!);
      if (this.turn === turn.id) this.turn = null;
      for (const resolve of this.turnEnds.get(turn.id) ?? []) resolve(outcome);
      this.turnEnds.delete(turn.id);
      this.emit({ type: "turn_completed", native_turn_id: turn.id, outcome });
      if (authenticationError(turn.error)) { this.authRequired = true; this.emit({ type: "state", state: "auth_required" }); }
    } else if (method === "serverRequest/resolved" && (typeof params.requestId === "number" || typeof params.requestId === "string")) {
      const key = nativeKey(params.requestId);
      const pending = this.pendingApprovals.get(key);
      if (pending?.file) fs.rmSync(pending.file, { force: true });
      this.pendingApprovals.delete(key);
      this.emit({ type: "approval_resolved", native_request_id: key });
    } else if (method === "thread/closed" || (method === "thread/status/changed" && object(params.status).type === "notLoaded")) {
      this.disconnected = true;
      this.emit({ type: "state", state: "disconnected" });
    } else if (method === "error") {
      if (authenticationError(params.error)) { this.authRequired = true; this.emit({ type: "state", state: "auth_required" }); }
    }
  }

  private approval(id: string | number, method: string, params: Json): void {
    // A request too large to review whole is never put to a human.
    const detail = approvalDetail({ method, params });
    if (params.threadId !== this.thread || detail === null ||
        (method !== "item/commandExecution/requestApproval" && method !== "item/fileChange/requestApproval")) {
      // This request is refused immediately: no pending question remains.
      this.emit({ type: "request_refused", method });
      void this.rpc.send({ id, error: { code: -32601, message: "This managed adapter does not support that request." } }).catch(() => {
        this.disconnected = true;
        this.emit({ type: "state", state: "disconnected" });
      });
      return;
    }
    if (this.pendingApprovals.size >= 32) { this.overflow(); return; }
    const key = nativeKey(id);
    if (this.pendingApprovals.has(key)) { this.overflow(); return; }
    const pending: PendingApproval = { id, method, choices: Array.isArray(params.availableDecisions) ? params.availableDecisions : null };
    const text = method.includes("commandExecution") ? String(params.command ?? params.reason ?? "Command approval") : JSON.stringify(params);
    let summary = displayText(text, Infinity);
    if (summary.length > 350) {
      const dir = path.join(this.nativeHome, "talking-stick-approvals", this.spec.worker_id);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      pending.file = path.join(dir, `${this.generation}-${createHash("sha256").update(key).digest("hex").slice(0, 16)}.json`);
      fs.writeFileSync(pending.file, JSON.stringify({ method, params }, null, 2), { mode: 0o600, flag: "wx" });
      summary = `Full request: ${approvalSummary(pending.file)}\n${summary.slice(0, 120)}`;
    }
    this.pendingApprovals.set(key, pending);
    this.emit({ type: "approval_requested", native_request_id: key,
      tool: method.includes("commandExecution") ? "shell" : "file change", summary, detail });
  }

  async submit(input: { input_id: string; text: string; mode: InputMode }): Promise<InputOutcome> {
    if (!this.thread || this.closed || this.disconnected || this.resumeFailed || this.reloading ||
        (input.mode === "steer" && !this.turn) || (input.mode === "start_turn" && this.turn)) return "rejected";
    if (this.inputStarting) return "rejected";
    const target = this.turn;
    this.inputStarting = input.input_id;
    try {
      const result = await this.rpc.request(input.mode === "steer" ? "turn/steer" : "turn/start", {
        threadId: this.thread, input: [{ type: "text", text: input.text }], clientUserMessageId: input.input_id,
        ...(input.mode === "steer" ? { expectedTurnId: target } : {}) }, this.options.requestTimeoutMs ?? 10_000,
      () => this.emit({ type: "input", input_id: input.input_id, outcome: "written" }));
      const id = input.mode === "steer" ? result.turnId : object(result.turn).id;
      if (typeof id !== "string" || (target && id !== target)) return "uncertain";
      if (!this.completed.has(id)) this.turn = id;
      this.emit({ type: "input", input_id: input.input_id, outcome: "accepted", native_turn_id: id });
      // A steer can finish before its RPC response links this input to the
      // turn. Reassert the known completion after that link, so its journal
      // cannot remain accepted forever. Completing a turn is idempotent.
      const completed = this.completed.get(id);
      if (completed) {
        this.emit({ type: "turn_completed", native_turn_id: id, outcome: completed });
        // A newer native unload/auth notification still wins over this
        // journal-link repair; it must not make a blocked worker idle.
        if (this.authRequired) this.emit({ type: "state", state: "auth_required" });
        else if (this.disconnected) this.emit({ type: "state", state: "disconnected" });
      }
      return "accepted";
    } catch (error) {
      if (error instanceof RpcError && error.auth) { this.authRequired = true; this.emit({ type: "state", state: "auth_required" }); }
      return error instanceof RpcError && error.unsent ? "rejected" : "uncertain";
    }
    finally { this.inputStarting = null; }
  }
  async interrupt(expectedTurnId?: string): Promise<"interrupted" | "not_busy" | "unsupported"> {
    const turn = this.turn;
    if (!turn || !this.thread || (expectedTurnId !== undefined && turn !== expectedTurnId)) return "not_busy";
    try {
      await this.rpc.request("turn/interrupt", { threadId: this.thread, turnId: turn }, this.options.requestTimeoutMs ?? 10_000);
      if (this.completed.get(turn) === "interrupted") return "interrupted";
      if (this.completed.has(turn)) return "not_busy";
      const outcome = await new Promise<string>((resolve) => {
        const done = (value: string) => {
          clearTimeout(timer);
          const remaining = (this.turnEnds.get(turn) ?? []).filter((callback) => callback !== done);
          if (remaining.length) this.turnEnds.set(turn, remaining); else this.turnEnds.delete(turn);
          resolve(value);
        };
        const timer = setTimeout(() => done("unconfirmed"), this.options.requestTimeoutMs ?? 10_000);
        this.turnEnds.set(turn, [...(this.turnEnds.get(turn) ?? []), done]);
      });
      return outcome === "interrupted" ? "interrupted" : "unsupported";
    } catch { return "unsupported"; }
  }
  async answerApproval(key: string, decision: "allow" | "deny"): Promise<void> {
    const pending = this.pendingApprovals.get(key);
    if (!pending || this.closed) throw new Error("That native approval is no longer pending.");
    // decline refuses this action and continues; cancel would interrupt the turn.
    const choice = decision === "allow" ? "accept" : "decline";
    if (pending.choices && !pending.choices.includes(choice)) throw new Error("The native request does not permit that decision.");
    await this.rpc.send({ id: pending.id, result: { decision: choice } });
  }
  async probe(): Promise<"alive" | "gone" | "unknown"> {
    if (!this.child?.alive()) return "gone";
    const inspection = createSystemProcessInspector().inspect(this.pid);
    if (!inspection) return inspection === null ? "gone" : "unknown";
    if (inspection.startTime?.trim() !== this.processStartedAt) return inspection.startTime ? "gone" : "unknown";
    if (!this.thread) return "unknown";
    if (this.resumeFailed) return "unknown";
    try {
      if (this.authRequired && !await this.checkAuthentication()) return "alive";
      const result = await this.rpc.request("thread/read", { threadId: this.thread, includeTurns: false }, 2_000);
      const thread = object(result.thread);
      const state = object(thread.status).type;
      if (thread.id === this.thread && (state === "notLoaded" || this.disconnected)) {
        return await this.reloadIdleThread() ? "alive" : "unknown";
      }
      return thread.id === this.thread && (state === "active" || state === "idle") ? "alive" : "unknown";
    } catch {
      // A closed-thread notification is sufficient evidence to try its exact
      // persisted session even if thread/read can no longer find it loaded.
      return this.disconnected && !this.resumeFailed && await this.reloadIdleThread() ? "alive" : "unknown";
    }
  }
  private reloadIdleThread(): Promise<boolean> {
    if (this.reloading) return this.reloading;
    if (this.resumeFailed || !this.thread) return Promise.resolve(false);
    this.disconnected = true;
    this.emit({ type: "state", state: "disconnected" });
    // Lost completion of a potentially running turn is not permission to
    // reload or replay side effects. Keep its inputs uncertain and hold.
    if (this.turn || this.inputStarting || this.pendingApprovals.size) {
      this.resumeFailed = true; this.emit({ type: "resume_failed" }); return Promise.resolve(false);
    }
    const session = this.thread;
    this.reloading = (async () => {
      try {
        await this.openThread(session);
        this.disconnected = false;
        this.emit({ type: "state", state: "idle" });
        return true;
      } catch {
        this.resumeFailed = true;
        this.emit({ type: "resume_failed" });
        return false;
      } finally { this.reloading = null; }
    })();
    return this.reloading;
  }
  exited(code: number | null, signal: string | null): void {
    if (this.closed) return;
    this.closed = true; this.rpc.close();
    for (const pending of this.pendingApprovals.values()) if (pending.file) fs.rmSync(pending.file, { force: true });
    this.pendingApprovals.clear();
    for (const callbacks of this.turnEnds.values()) for (const callback of callbacks) callback("unconfirmed");
    this.turnEnds.clear();
    this.emit({ type: "exited", code, signal });
  }
  async stop(graceMs: number): Promise<void> { await this.child?.stop(graceMs); this.rpc.close(); }
}

/**
 * Where Codex's workspace-write sandbox lets commands write, from the policy it
 * returned: the cwd, each writable root, and the temp directories it doesn't
 * exclude. Any other policy, or one it didn't describe completely, is unconfined.
 */
export function effectiveConfinement(sandbox: Record<string, unknown>, cwd: string, tmpdir: string | null): Confinement {
  if (sandbox.type === "readOnly") return { kind: "read_only" };
  if (sandbox.type !== "workspaceWrite") return { kind: "unconfined", reason: `its sandbox is ${String(sandbox.type ?? "unreported")}` };
  const roots = sandbox.writableRoots ?? [];
  if (!Array.isArray(roots) || roots.some((root) => typeof root !== "string" || !path.isAbsolute(root)) || !path.isAbsolute(cwd)) {
    return { kind: "unconfined", reason: "its writable roots were not reported as absolute paths" };
  }
  return { kind: "workspace_write", writable: [cwd, ...roots as string[],
    ...(sandbox.excludeSlashTmp === true ? [] : ["/tmp"]),
    ...(sandbox.excludeTmpdirEnvVar === true || !tmpdir ? [] : [tmpdir])] };
}
