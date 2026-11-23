import fs from "node:fs";
import path from "node:path";
import Hjson from "hjson";
import { createProcessEvidence } from "../../supervisor-process-evidence.js";
import {
  AuthModeError, WorkerExecutableError,
  type Capabilities, type HarnessAdapter, type InputOutcome, type SpawnedProcess, type WorkerEvent,
  type WorkerHandle, type WorkerSpec
} from "../adapter.js";
import { approvalDetail, approvalSummary } from "../approval-detail.js";
import { AcpError, AcpRpc, acpObject, type AcpObject } from "./acp-rpc.js";
import { spawnManagedProcess, workerEnvironment, type ManagedProcess } from "./process.js";

export interface AntigravityAdapterOptions {
  command?: string;
  argsPrefix?: string[];
  startTimeoutMs?: number;
}

function resolveExecutable(env: NodeJS.ProcessEnv): string {
  const explicit = env.AGY_EXECUTABLE;
  if (explicit && !path.isAbsolute(explicit)) {
    throw new WorkerExecutableError("AGY_EXECUTABLE", "AGY_EXECUTABLE must be an absolute executable path.");
  }
  const candidates = explicit ? [explicit] : (env.PATH ?? "").split(path.delimiter).filter(Boolean)
    .map(dir => path.join(dir, "agy"));
  for (const candidate of candidates) {
    try {
      const real = fs.realpathSync(candidate);
      if (["mise", "asdf"].includes(path.basename(real)) || !fs.statSync(real).isFile()) continue;
      fs.accessSync(real, fs.constants.X_OK);
      return real;
    } catch { /* Try the next PATH entry. */ }
  }
  throw new WorkerExecutableError("AGY_EXECUTABLE", "Cannot resolve the agy executable.");
}

function checkAccountSettings(home: string): void {
  // Inspect the selected auth modes only. The harness owns login and keychain
  // access. The worker environment separately excludes API and ADC overrides.
  for (const directory of ["antigravity-cli", "config"]) {
    const file = path.join(home, ".gemini", directory, "settings.json");
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new AuthModeError("wrong_auth_mode", "Cannot read Antigravity authentication settings.");
    }
    let settings: AcpObject;
    try {
      settings = acpObject(Hjson.parse(raw));
    } catch {
      throw new AuthModeError("wrong_auth_mode", "Cannot verify Antigravity authentication settings.");
    }
    const type = acpObject(settings.auth).type;
    if ((type && type !== "oauth-personal" && type !== "oauth-business" && type !== "terminal-login") ||
        settings.modelProvider || acpObject(settings.gcp).project) {
      throw new AuthModeError("wrong_auth_mode", "Sign in to Antigravity with a Google account before starting the worker.");
    }
  }
}

export class AntigravityAdapter implements HarnessAdapter {
  readonly harness = "antigravity" as const;
  constructor(private readonly options: AntigravityAdapterOptions = {}) {}
  capabilities(): Capabilities {
    const supported = process.platform !== "win32";
    return { prompt: supported, resume: supported, interrupt: supported, approvals: supported };
  }

  async start(spec: WorkerSpec, generation: number, onSpawn: (child: SpawnedProcess) => void,
    signal?: AbortSignal): Promise<WorkerHandle> {
    if (spec.harness !== "antigravity" || spec.permissions.harness !== "antigravity") {
      throw new Error("Antigravity needs explicit Antigravity permissions.");
    }
    const env = workerEnvironment(spec);
    checkAccountSettings(env.HOME!);
    const token = spec.supervisor_env?.TT_SUPERVISOR_TOKEN;
    const endpoint = spec.supervisor_env?.TT_SUPERVISOR_ENDPOINT;
    const evidence = spec.state_dir && token && endpoint && createProcessEvidence({
      stateDir: spec.state_dir, workerId: spec.worker_id, generation, harness: this.harness, endpoint, token
    });
    if (evidence) env.TT_SUPERVISOR_PROCESS_FILE = evidence.file;
    const handle = new AntigravityHandle(generation);
    try {
      const child = await spawnManagedProcess({
        command: this.options.command ?? resolveExecutable(env),
        args: [...(this.options.argsPrefix ?? []), "acp", "--stdio",
          ...(spec.permissions.mode === "bypassPermissions" ? ["--dangerously-skip-permissions"] : [])],
        cwd: spec.cwd,
        env,
        signal,
        onSpawn: child => {
          if (evidence) evidence.record(child);
          onSpawn(child);
        },
        onLine: line => handle.receive(line),
        onExit: (code, exitSignal) => {
          if (evidence) evidence.clear();
          handle.exit(code, exitSignal);
        },
        onOverflow: () => handle.fail({ type: "overflow" })
      });
      handle.attach(child);
      await handle.initialize(spec.cwd, spec.resume_session_id, this.options.startTimeoutMs ?? 15_000);
      if (signal?.aborted) throw new Error("Antigravity start aborted.");
      return handle;
    } catch (error) {
      await handle.stop(100).catch(() => {});
      if (evidence) evidence.clear();
      if (error instanceof AcpError && error.auth) {
        throw new AuthModeError("auth_required", "Sign in to Antigravity before starting this worker.");
      }
      throw error;
    }
  }
}

interface Turn {
  id: string;
  inputId: string;
  started: boolean;
}

const TURN_UPDATES = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"]);

class AntigravityHandle implements WorkerHandle {
  readonly generation: number;
  private readonly rpc = new AcpRpc();
  private child?: ManagedProcess;
  private session: string | null = null;
  private turn?: Turn;
  private listener?: (event: WorkerEvent) => void;
  private queued: WorkerEvent[] = [];
  private requested = new Map<string, number | string>();
  private terminal = false;

  constructor(generation: number) { this.generation = generation; }
  get pid(): number { return this.child!.pid; }
  get processStartedAt(): string { return this.child!.processStartedAt; }
  get pgid(): number { return this.child!.pgid; }
  attach(child: ManagedProcess): void { this.child = child; this.rpc.process = child; }
  sessionId(): string | null { return this.session; }

  onEvent(listener: (event: WorkerEvent) => void): void {
    this.listener = listener;
    for (const event of this.queued.splice(0)) listener(event);
  }

  private emit(event: WorkerEvent): void {
    if (this.listener) this.listener(event);
    else if (this.queued.length < 64) this.queued.push(event);
    else this.fail({ type: "overflow" });
  }

  fail(event: WorkerEvent): void {
    if (this.terminal) return;
    this.terminal = true;
    if (this.listener) this.listener(event);
    else this.queued = [event];
    this.rpc.close();
    void this.child?.stop(100).catch(() => {});
  }

  exit(code: number | null, signal: string | null): void {
    this.rpc.close();
    this.terminal = true;
    this.emit({ type: "exited", code, signal });
  }

  async initialize(cwd: string, resume: string | undefined, timeout: number): Promise<void> {
    const initialized = await this.rpc.request("initialize", {
      protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "shrooms", version: "0" }
    }, timeout);
    if (initialized.protocolVersion !== 1) throw new Error("Antigravity did not negotiate ACP version 1.");
    const params = { cwd, mcpServers: [] };
    const result = resume
      ? await this.rpc.request("session/resume", { ...params, sessionId: resume }, timeout)
      : await this.rpc.request("session/new", params, timeout);
    if (typeof result.sessionId !== "string" || !result.sessionId || (resume && result.sessionId !== resume)) {
      throw new Error("Antigravity did not confirm the requested conversation.");
    }
    this.session = result.sessionId;
    this.emit({ type: "session", session_id: this.session });
  }

  receive(line: string): void {
    if (this.terminal) return;
    let message: AcpObject;
    try {
      message = acpObject(JSON.parse(line));
    } catch {
      this.fail({ type: "protocol_error" });
      return;
    }
    if (message.jsonrpc !== "2.0") {
      this.fail({ type: "protocol_error" });
      return;
    }
    if (typeof message.method !== "string") {
      this.rpc.complete(message);
      return;
    }
    const params = acpObject(message.params);
    if (message.method === "session/update") {
      const update = acpObject(params.update).sessionUpdate;
      if (params.sessionId === this.session && this.turn && typeof update === "string" && TURN_UPDATES.has(update)) {
        this.started(this.turn);
      }
      return;
    }
    if (typeof message.id !== "number" && typeof message.id !== "string") return;
    if (message.method === "session/request_permission" && params.sessionId === this.session && this.turn) {
      this.started(this.turn);
      const key = JSON.stringify(message.id);
      if (this.requested.has(key) || this.requested.size >= 32) {
        this.fail({ type: "protocol_error" });
        return;
      }
      const detail = approvalDetail(params);
      if (!detail) {
        this.emit({ type: "request_refused", method: message.method });
        void this.cancelPermission(message.id).catch(() => this.fail({ type: "protocol_error" }));
        return;
      }
      this.requested.set(key, message.id);
      const title = acpObject(params.toolCall).title;
      this.emit({ type: "approval_requested", native_request_id: key, tool: "Antigravity tool",
        summary: approvalSummary(typeof title === "string" ? title : "Permission requested."),
        detail });
      return;
    }
    this.emit({ type: "request_refused", method: message.method });
    void this.respond({ id: message.id, error: { code: -32601, message: "Method not available." } })
      .catch(() => this.fail({ type: "protocol_error" }));
  }

  private started(turn: Turn): void {
    if (turn.started) return;
    turn.started = true;
    this.emit({ type: "turn_started", native_turn_id: turn.id, input_id: turn.inputId });
  }

  submit(input: Parameters<WorkerHandle["submit"]>[0]): Promise<InputOutcome> {
    if (input.mode !== "start_turn" || this.turn || !this.session || this.terminal) return Promise.resolve("rejected");
    const turn: Turn = { id: input.input_id, inputId: input.input_id, started: false };
    this.turn = turn;
    return new Promise(resolve => {
      void this.rpc.request("session/prompt", { sessionId: this.session,
        prompt: [{ type: "text", text: input.text }] }, 30 * 60_000,
      () => resolve("written")).then(result => {
        if (typeof result.stopReason !== "string" ||
            (result.sessionId !== undefined && result.sessionId !== this.session)) {
          resolve("uncertain");
          this.fail({ type: "protocol_error" });
          return;
        }
        this.started(turn);
        this.finish(turn, result.stopReason === "cancelled" ? "interrupted" : result.stopReason === "end_turn" ? "success" : "error");
        resolve("accepted");
      }).catch((error: unknown) => {
        if (error instanceof AcpError && error.phase === "unsent") {
          this.turn = undefined;
          resolve("rejected");
          return;
        }
        resolve("uncertain");
        if (error instanceof AcpError && error.phase === "rejected") {
          this.emit({ type: "input", input_id: turn.inputId, outcome: "uncertain", native_turn_id: turn.id });
          this.finish(turn, "error");
          if (error.auth) this.emit({ type: "state", state: "auth_required" });
          return;
        }
        this.fail({ type: "protocol_error" });
      });
    });
  }

  private finish(turn: Turn, outcome: "success" | "error" | "interrupted"): void {
    this.turn = undefined;
    for (const native_request_id of this.requested.keys()) this.emit({ type: "approval_resolved", native_request_id });
    this.requested.clear();
    this.emit({ type: "turn_completed", native_turn_id: turn.id, outcome });
  }

  async interrupt(expectedTurnId?: string): Promise<"interrupted" | "not_busy"> {
    if (!this.turn || (expectedTurnId && this.turn.id !== expectedTurnId) || !this.session) return "not_busy";
    await this.respond({ method: "session/cancel", params: { sessionId: this.session } });
    return "interrupted";
  }

  async answerApproval(nativeRequestId: string, decision: "allow" | "deny"): Promise<void> {
    const id = this.requested.get(nativeRequestId);
    if (id === undefined || decision !== "deny") throw new Error("Antigravity has no matching denial to deliver.");
    this.requested.delete(nativeRequestId);
    await this.cancelPermission(id);
  }

  private cancelPermission(id: number | string): Promise<void> {
    return this.respond({ id, result: { outcome: { outcome: "cancelled" } } });
  }

  private async respond(body: AcpObject): Promise<void> {
    if (!this.child?.alive()) throw new Error("Antigravity ACP connection ended.");
    await this.child.write(JSON.stringify({ jsonrpc: "2.0", ...body }));
  }

  async probe(): Promise<"alive" | "gone" | "unknown"> {
    if (!this.child?.alive()) return "gone";
    if (!this.session || this.terminal) return "unknown";
    try {
      const result = await this.rpc.request("session/list", {}, 2_000);
      return Array.isArray(result.sessions) && result.sessions.some(item => acpObject(item).sessionId === this.session)
        ? "alive" : "unknown";
    } catch {
      return this.child.alive() ? "unknown" : "gone";
    }
  }

  async stop(graceMs: number): Promise<void> {
    await this.child?.stop(graceMs);
    this.rpc.close();
  }
}
