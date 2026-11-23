import { createSystemProcessInspector } from "../../process-utils.js";
import type { InputOutcome, WorkerEvent, WorkerHandle } from "../adapter.js";
import { approvalDetail, approvalSummary } from "../approval-detail.js";
import { AcpError, AcpRpc, acpObject, type AcpObject } from "./acp-rpc.js";
import type { ManagedProcess } from "./process.js";

interface Turn {
  id: string;
  inputId: string;
  started: boolean;
}

const TURN_UPDATES = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"]);

export class AcpWorkerHandle implements WorkerHandle {
  readonly generation: number;
  private readonly rpc = new AcpRpc();
  private child?: ManagedProcess;
  private session: string | null = null;
  private turn?: Turn;
  private listener?: (event: WorkerEvent) => void;
  private queued: WorkerEvent[] = [];
  private requested = new Map<string, number | string>();
  private terminal = false;

  constructor(generation: number, private readonly native: {
    name: string; resumeEchoesSession: boolean; journalPermissions: boolean;
  }) { this.generation = generation; }
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
      protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "talking_stick_supervisor", version: "0" }
    }, timeout);
    if (initialized.protocolVersion !== 1) throw new Error(`${this.native.name} did not negotiate ACP version 1.`);
    const params = { cwd, mcpServers: [] };
    const result = resume
      ? await this.rpc.request("session/resume", { ...params, sessionId: resume }, timeout)
      : await this.rpc.request("session/new", params, timeout);
    const session = resume && !this.native.resumeEchoesSession && result.sessionId === undefined
      ? resume : result.sessionId;
    if (typeof session !== "string" || !session || (resume && session !== resume)) {
      throw new Error(`${this.native.name} did not confirm the requested conversation.`);
    }
    this.session = session;
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
      const detail = this.native.journalPermissions ? approvalDetail(params) : null;
      if (!detail) {
        this.emit({ type: "request_refused", method: message.method });
        void this.cancelPermission(message.id).catch(() => this.fail({ type: "protocol_error" }));
        return;
      }
      this.requested.set(key, message.id);
      const title = acpObject(params.toolCall).title;
      this.emit({ type: "approval_requested", native_request_id: key, tool: `${this.native.name} tool`,
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
        prompt: [{ type: "text", text: input.text }] }, undefined,
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
    if (id === undefined || decision !== "deny") throw new Error(`${this.native.name} has no matching denial to deliver.`);
    this.requested.delete(nativeRequestId);
    await this.cancelPermission(id);
  }

  private cancelPermission(id: number | string): Promise<void> {
    return this.respond({ id, result: { outcome: { outcome: "cancelled" } } });
  }

  private async respond(body: AcpObject): Promise<void> {
    if (!this.child?.alive()) throw new Error(`${this.native.name} ACP connection ended.`);
    await this.child.write(JSON.stringify({ jsonrpc: "2.0", ...body }));
  }

  async probe(): Promise<"alive" | "gone" | "unknown"> {
    if (!this.child?.alive()) return "gone";
    if (!this.session || this.terminal) return "unknown";
    const inspection = createSystemProcessInspector().inspect(this.pid);
    if (!inspection?.startTime) return inspection === null ? "gone" : "unknown";
    if (inspection.startTime.trim() !== this.processStartedAt) return "gone";
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
