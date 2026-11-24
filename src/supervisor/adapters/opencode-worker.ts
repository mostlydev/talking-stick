import { randomBytes } from "node:crypto";
import { createSystemProcessInspector } from "../../process-utils.js";
import type { InputOutcome, SpawnedProcess, WorkerEvent, WorkerHandle } from "../adapter.js";
import { approvalSummary } from "../approval-detail.js";
import { spawnManagedProcess, type ManagedProcess } from "./process.js";

// The transport for an OpenCode 2.4+ worker: a private `opencode serve --stdio`
// in the supervisor's own process group. It announces one loopback URL on
// stdout, takes requests only with this generation's random password, and
// exits when its stdin closes. Nothing registers it as an adapter yet: the
// model and permission gate is checked separately.

/** A catalog model as OpenCode names it: its provider and the model's catalog id. */
export interface OpencodeModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

/** One OpenCode permission rule, as session.create takes them. */
export interface OpencodePermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

export interface OpencodeStartOptions {
  command: string;
  /** Before `serve`, such as a script path when the command is an interpreter. */
  argsPrefix?: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  generation: number;
  /** Resume this conversation; a start that cannot find it fails. */
  resumeSessionId?: string;
  /** Applied to a new conversation only; a resumed one keeps its own. */
  session?: { permissions?: OpencodePermissionRule[]; model?: OpencodeModelRef };
  onSpawn(process: SpawnedProcess): void;
  signal?: AbortSignal;
  startTimeoutMs?: number;
  requestTimeoutMs?: number;
}

interface Turn {
  inputId: string;
  inboxId: string;
  started: boolean;
}

type Json = Record<string, unknown>;

const MAX_PENDING_APPROVALS = 32;
const MAX_EVENT_BYTES = 256 * 1024;

function object(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

/** Only the exact loopback address this process announced is trusted. */
export function parseAnnouncedUrl(line: string): string | null {
  let url: unknown;
  try { url = object(JSON.parse(line)).url; } catch { return null; }
  if (typeof url !== "string") return null;
  const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(url);
  return match && Number(match[1]) > 0 && Number(match[1]) < 65536 ? url : null;
}

/** Splits a server-sent event stream into the JSON of each data line, bounded. */
export class SseParser {
  private buffer = "";
  constructor(private readonly onFrame: (frame: Json) => void, private readonly onOverflow: () => void) {}
  push(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (!line.startsWith("data:")) continue;
      let frame: unknown;
      try { frame = JSON.parse(line.slice(5).trimStart()); } catch { continue; }
      const parsed = object(frame);
      // Frames may carry the event itself or wrap it.
      this.onFrame(Object.keys(object(parsed.event)).length ? object(parsed.event) : parsed);
    }
    if (this.buffer.length > MAX_EVENT_BYTES) {
      this.buffer = "";
      this.onOverflow();
    }
  }
}

export class OpencodeWorkerHandle implements WorkerHandle {
  readonly generation: number;
  private child?: ManagedProcess;
  private baseUrl?: string;
  private readonly authorization: string;
  private session: string | null = null;
  private turn?: Turn;
  private listener?: (event: WorkerEvent) => void;
  private queued: WorkerEvent[] = [];
  private readonly pending = new Set<string>();
  private terminal = false;
  private readonly events = new AbortController();
  private announced?: (url: string | null) => void;

  constructor(generation: number, readonly password: string, private readonly requestTimeoutMs = 10_000) {
    this.generation = generation;
    this.authorization = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
  }

  get pid(): number { return this.child!.pid; }
  get processStartedAt(): string { return this.child!.processStartedAt; }
  get pgid(): number { return this.child!.pgid; }
  sessionId(): string | null { return this.session; }
  attach(child: ManagedProcess): void { this.child = child; }

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
    this.events.abort();
    if (this.listener) this.listener(event);
    else this.queued = [event];
    void this.child?.stop(100).catch(() => {});
  }

  exit(code: number | null, signal: string | null): void {
    this.terminal = true;
    this.events.abort();
    this.announced?.(null);
    this.emit({ type: "exited", code, signal });
  }

  /** The first stdout line announces the URL; anything after it is ignored. */
  receive(line: string): void {
    if (this.baseUrl !== undefined || !this.announced) return;
    const url = parseAnnouncedUrl(line);
    this.announced(url);
  }

  waitForUrl(timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.announced = undefined; reject(new Error("OpenCode did not announce its server.")); }, timeoutMs);
      this.announced = (url) => {
        clearTimeout(timer);
        this.announced = undefined;
        if (!url) { reject(new Error("OpenCode announced no loopback server.")); return; }
        this.baseUrl = url;
        resolve(url);
      };
    });
  }

  private async request(method: string, route: string, body?: unknown, timeoutMs = this.requestTimeoutMs): Promise<{ status: number; json: Json }> {
    const response = await fetch(this.baseUrl + route, {
      method,
      headers: { Authorization: this.authorization, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    let json: Json = {};
    if (text) { try { json = object(JSON.parse(text)); } catch { /* not JSON: status decides */ } }
    return { status: response.status, json };
  }

  /** Opens the event stream before any conversation exists, so no event of it is missed. */
  async subscribe(timeoutMs: number): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/event`, {
      headers: { Authorization: this.authorization, Accept: "text/event-stream" },
      signal: AbortSignal.any([this.events.signal, AbortSignal.timeout(timeoutMs)])
    });
    if (response.status === 401) throw new Error("OpenCode refused this generation's credentials.");
    if (!response.ok || !response.body) throw new Error(`OpenCode's event stream answered ${response.status}.`);
    const parser = new SseParser((frame) => this.handle(frame), () => this.fail({ type: "overflow" }));
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    // The timeout above bounds only the connection; the stream itself stays open.
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          parser.push(value);
        }
        if (!this.terminal && this.child?.alive()) this.fail({ type: "protocol_error" });
      } catch {
        if (!this.terminal && this.child?.alive()) this.fail({ type: "protocol_error" });
      }
    })();
  }

  async openSession(cwd: string, resume: string | undefined, settings: OpencodeStartOptions["session"]): Promise<void> {
    let id: string;
    if (resume) {
      id = resume;
    } else {
      const created = await this.request("POST", "/api/session", {
        location: { directory: cwd },
        ...(settings?.permissions ? { permissions: settings.permissions } : {}),
        ...(settings?.model ? { model: settings.model } : {})
      });
      const createdId = object(created.json.data).id;
      if (created.status !== 200 || typeof createdId !== "string" || !createdId) throw new Error(`OpenCode did not create a conversation (${created.status}).`);
      id = createdId;
    }
    // Read it back: the conversation must be exactly this one, in this
    // worker's folder, on the requested model, before it takes any input.
    const found = await this.request("GET", `/api/session/${encodeURIComponent(id)}`);
    const info = object(found.json.data);
    if (found.status !== 200 || info.id !== id) {
      throw new Error(resume ? "OpenCode could not find the conversation to resume." : "OpenCode lost the conversation it created.");
    }
    if (object(info.location).directory !== cwd) throw new Error("The OpenCode conversation belongs to another folder.");
    const model = object(info.model);
    if (!resume && settings?.model && (model.providerID !== settings.model.providerID || model.id !== settings.model.id)) {
      throw new Error("OpenCode did not set the requested model on the conversation.");
    }
    this.session = id;
    this.emit({ type: "session", session_id: id });
  }

  private handle(event: Json): void {
    if (this.terminal) return;
    const data = object(event.data);
    if (data.sessionID !== this.session || !this.session) return;
    switch (event.type) {
      case "session.inbox.delivered":
        if (this.turn && data.inboxID === this.turn.inboxId) this.started(this.turn);
        return;
      case "session.execution.started":
        if (this.turn) this.started(this.turn);
        return;
      case "session.execution.succeeded":
        this.finish("success");
        return;
      case "session.execution.failed":
        this.finish("error");
        return;
      case "session.execution.interrupted":
        this.finish("interrupted");
        return;
      case "permission.asked": {
        const id = data.id;
        if (typeof id !== "string" || !id || this.pending.has(id)) return;
        if (this.pending.size >= MAX_PENDING_APPROVALS) { this.fail({ type: "protocol_error" }); return; }
        if (this.turn) this.started(this.turn);
        this.pending.add(id);
        const action = typeof data.action === "string" ? data.action : "tool";
        const message = typeof data.message === "string" ? data.message : `OpenCode asks to ${action}.`;
        this.emit({ type: "approval_requested", native_request_id: id, tool: `OpenCode ${action}`,
          summary: approvalSummary(message), detail: JSON.stringify(data, null, 2) });
        return;
      }
      case "permission.replied":
        if (typeof data.requestID === "string" && this.pending.delete(data.requestID)) {
          this.emit({ type: "approval_resolved", native_request_id: data.requestID });
        }
        return;
      case "session.deleted":
        this.fail({ type: "protocol_error" });
        return;
      default:
        return;
    }
  }

  private started(turn: Turn): void {
    if (turn.started) return;
    turn.started = true;
    this.emit({ type: "turn_started", native_turn_id: turn.inboxId, input_id: turn.inputId });
  }

  private finish(outcome: "success" | "error" | "interrupted"): void {
    const turn = this.turn;
    if (!turn) return;
    this.started(turn);
    this.turn = undefined;
    for (const id of this.pending) this.emit({ type: "approval_resolved", native_request_id: id });
    this.pending.clear();
    this.emit({ type: "turn_completed", native_turn_id: turn.inboxId, outcome });
  }

  async submit(input: { input_id: string; text: string; mode: "start_turn" | "steer" }): Promise<InputOutcome> {
    if (input.mode !== "start_turn" || this.turn || !this.session || this.terminal || !this.baseUrl) return "rejected";
    const placeholder: Turn = { inputId: input.input_id, inboxId: "", started: false };
    this.turn = placeholder;
    let result: { status: number; json: Json };
    try {
      result = await this.request("POST", `/api/session/${encodeURIComponent(this.session)}/prompt`,
        { text: input.text, delivery: "queue" });
    } catch (error) {
      // A refused connection sent nothing; any other failure may have.
      const code = (error as { cause?: { code?: string } }).cause?.code;
      if (code === "ECONNREFUSED") { this.turn = undefined; return "rejected"; }
      this.turn = undefined;
      this.emit({ type: "input", input_id: input.input_id, outcome: "uncertain" });
      return "uncertain";
    }
    const inbox = object(result.json.data);
    if (result.status === 200 && typeof inbox.id === "string" && inbox.id && inbox.sessionID === this.session) {
      if (this.turn === placeholder) placeholder.inboxId = inbox.id;
      return "written";
    }
    this.turn = undefined;
    if (result.status === 401) this.fail({ type: "protocol_error" });
    return result.status >= 400 && result.status < 500 ? "rejected" : "uncertain";
  }

  async interrupt(expectedTurnId?: string): Promise<"interrupted" | "not_busy" | "unsupported"> {
    const turn = this.turn;
    if (!turn || !this.session || (expectedTurnId && turn.inboxId !== expectedTurnId)) return "not_busy";
    const result = await this.request("POST", `/api/session/${encodeURIComponent(this.session)}/interrupt`);
    return result.status === 200 && result.json.interrupted === true ? "interrupted" : "not_busy";
  }

  async answerApproval(nativeRequestId: string, decision: "allow" | "deny", note?: string): Promise<void> {
    if (decision !== "deny" || !this.pending.has(nativeRequestId) || !this.session) {
      throw new Error("OpenCode has no matching denial to deliver.");
    }
    const result = await this.request("POST",
      `/api/session/${encodeURIComponent(this.session)}/permission/${encodeURIComponent(nativeRequestId)}/reply`,
      { decision: "reject", ...(note ? { message: note } : {}) });
    if (result.status !== 204 && result.status !== 200) throw new Error(`OpenCode did not take the denial (${result.status}).`);
    if (this.pending.delete(nativeRequestId)) this.emit({ type: "approval_resolved", native_request_id: nativeRequestId });
  }

  async probe(): Promise<"alive" | "gone" | "unknown"> {
    if (!this.child?.alive()) return "gone";
    if (!this.session || this.terminal) return "unknown";
    const inspection = createSystemProcessInspector().inspect(this.pid);
    if (!inspection?.startTime) return inspection === null ? "gone" : "unknown";
    if (inspection.startTime.trim() !== this.processStartedAt) return "gone";
    try {
      const result = await this.request("GET", `/api/session/${encodeURIComponent(this.session)}`, undefined, 2_000);
      return result.status === 200 && object(result.json.data).id === this.session ? "alive" : "unknown";
    } catch {
      return this.child.alive() ? "unknown" : "gone";
    }
  }

  async stop(graceMs: number): Promise<void> {
    this.events.abort();
    await this.child?.stop(graceMs);
  }
}

/**
 * Starts a private OpenCode server for one worker generation and opens its
 * conversation. The password is fresh for each generation and is never
 * stored, so a server that outlives its supervisor cannot be driven again.
 */
export async function startOpencodeWorker(options: OpencodeStartOptions): Promise<OpencodeWorkerHandle> {
  const password = randomBytes(24).toString("hex");
  const handle = new OpencodeWorkerHandle(options.generation, password, options.requestTimeoutMs);
  const timeout = options.startTimeoutMs ?? 15_000;
  const announced = handle.waitForUrl(timeout);
  announced.catch(() => {});
  try {
    const child = await spawnManagedProcess({
      command: options.command,
      args: [...(options.argsPrefix ?? []), "serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"],
      cwd: options.cwd,
      env: { ...options.env, OPENCODE_SERVER_PASSWORD: password },
      signal: options.signal,
      onSpawn: options.onSpawn,
      onLine: (line) => handle.receive(line),
      onExit: (code, signal) => handle.exit(code, signal),
      onOverflow: () => handle.fail({ type: "overflow" })
    });
    handle.attach(child);
    await announced;
    await handle.subscribe(timeout);
    await handle.openSession(options.cwd, options.resumeSessionId, options.session);
    if (options.signal?.aborted) throw new Error("OpenCode start aborted.");
    return handle;
  } catch (error) {
    await handle.stop(100).catch(() => {});
    throw error;
  }
}
