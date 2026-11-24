import { randomBytes } from "node:crypto";
import { createSystemProcessInspector } from "../../process-utils.js";
import { AuthModeError, type InputOutcome, type SpawnedProcess, type WorkerEvent, type WorkerHandle } from "../adapter.js";
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

/** The authenticated server, offered to a gate before any conversation is opened. */
export interface OpencodeServerAccess {
  url: string;
  authorization: string;
  cwd: string;
  signal: AbortSignal;
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
  /**
   * Runs against this generation's authenticated server before any
   * conversation is opened. Throwing (an AuthModeError) refuses the start;
   * a model it returns is pinned on a new conversation and must match a
   * resumed one, before every prompt.
   */
  beforeSession?: (server: OpencodeServerAccess) => Promise<{ model?: OpencodeModelRef } | void>;
  /** The model to require when no beforeSession supplies one. */
  model?: OpencodeModelRef;
  onSpawn(process: SpawnedProcess): void;
  signal?: AbortSignal;
  startTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** How long an admitted prompt may wait for its delivery or another outcome; a running turn has no cap. */
  ackTimeoutMs?: number;
}

interface Turn {
  inputId: string;
  /** Null while the prompt's admission is in flight; then the exact inbox item. */
  inboxId: string | null;
  /** Set only by session.inbox.delivered for that inbox item. */
  running: boolean;
}

type Json = Record<string, unknown>;

const MAX_PENDING_APPROVALS = 32;
const MAX_HELD_EVENTS = 256;
const MAX_ANCESTRY = 8;
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
      if (line.length > MAX_EVENT_BYTES) {
        this.buffer = "";
        this.onOverflow();
        return;
      }
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
  /** Pending permission requests: request id to the asking conversation, the root or a descendant. */
  private readonly pending = new Map<string, string>();
  private ackTimer?: ReturnType<typeof setTimeout>;
  private terminal = false;
  private readonly events = new AbortController();
  private announced?: (url: string | null) => void;
  /** This conversation's events that arrived while a prompt's admission was in flight. */
  private held: Json[] = [];
  private expected?: { cwd: string; model?: OpencodeModelRef };

  constructor(generation: number, readonly password: string, private readonly requestTimeoutMs = 10_000,
    private readonly ackTimeoutMs = 30_000) {
    this.generation = generation;
    this.authorization = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
  }

  get pid(): number { return this.child!.pid; }
  get processStartedAt(): string { return this.child!.processStartedAt; }
  get pgid(): number { return this.child!.pgid; }
  get url(): string | undefined { return this.baseUrl; }
  get authorizationHeader(): string { return this.authorization; }
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
    clearTimeout(this.ackTimer);
    this.events.abort();
    if (this.listener) this.listener(event);
    else this.queued = [event];
    void this.child?.stop(100).catch(() => {});
  }

  exit(code: number | null, signal: string | null): void {
    this.terminal = true;
    clearTimeout(this.ackTimer);
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
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    let json: Json = {};
    if (text) { try { json = object(JSON.parse(text)); } catch { /* not JSON: status decides */ } }
    return { status: response.status, json };
  }

  /** Opens the event stream before any conversation exists, so no event of it is missed. */
  async subscribe(timeoutMs: number): Promise<void> {
    // The timer bounds only the connection: a fetch signal would also end the
    // body, so it is cleared once the stream answers, and only stop() ends it.
    const connection = new AbortController();
    const stop = () => connection.abort();
    if (this.events.signal.aborted) stop();
    else this.events.signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/event`, {
        headers: { Authorization: this.authorization, Accept: "text/event-stream" },
        redirect: "error",
        signal: connection.signal
      });
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401) throw new Error("OpenCode refused this generation's credentials.");
    if (!response.ok || !response.body) throw new Error(`OpenCode's event stream answered ${response.status}.`);
    const parser = new SseParser((frame) => this.handle(frame), () => this.fail({ type: "overflow" }));
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
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

  async openSession(cwd: string, resume: string | undefined, model: OpencodeModelRef | undefined): Promise<void> {
    let id: string;
    if (resume) {
      id = resume;
    } else {
      const created = await this.request("POST", "/api/session", { location: { directory: cwd }, ...(model ? { model } : {}) });
      const createdId = object(created.json.data).id;
      if (created.status !== 200 || typeof createdId !== "string" || !createdId) throw new Error(`OpenCode did not create a conversation (${created.status}).`);
      id = createdId;
    }
    this.expected = { cwd, ...(model ? { model } : {}) };
    const problem = await this.checkSession(id);
    if (problem === "missing") {
      throw new Error(resume ? "OpenCode could not find the conversation to resume." : "OpenCode lost the conversation it created.");
    }
    if (problem === "folder") throw new Error("The OpenCode conversation belongs to another folder.");
    if (problem === "model") throw new AuthModeError("wrong_auth_mode", "The OpenCode conversation is not on the verified subscription model.");
    this.session = id;
    this.emit({ type: "session", session_id: id });
  }

  /**
   * Reads the conversation back: exactly this one, in this worker's folder,
   * and on the verified provider, model and variant when one is required.
   */
  private async checkSession(id: string): Promise<"ok" | "missing" | "folder" | "model"> {
    const found = await this.request("GET", `/api/session/${encodeURIComponent(id)}`);
    const info = object(found.json.data);
    if (found.status !== 200 || info.id !== id) return "missing";
    if (object(info.location).directory !== this.expected?.cwd) return "folder";
    const required = this.expected?.model;
    if (required) {
      const model = object(info.model);
      // OpenCode stores a model without a variant as its "default" variant.
      if (model.providerID !== required.providerID || model.id !== required.id ||
          (model.variant ?? "default") !== (required.variant ?? "default")) return "model";
    }
    return "ok";
  }

  private handle(event: Json): void {
    if (this.terminal) return;
    const data = object(event.data);
    if (!this.session) return;
    // Permission requests from any conversation on this private server are
    // answered (a subagent's included); everything else is the root's alone.
    const permission = event.type === "permission.asked" || event.type === "permission.replied";
    if (data.sessionID !== this.session && !permission) return;
    // Until the admission response names the inbox item, nothing can be
    // attributed to it: hold this conversation's events and apply them after.
    if (this.turn && this.turn.inboxId === null) {
      if (this.held.length >= MAX_HELD_EVENTS) { this.fail({ type: "overflow" }); return; }
      this.held.push(event);
      return;
    }
    this.apply(event, data);
  }

  private release(): void {
    for (const event of this.held.splice(0)) {
      if (this.terminal) return;
      this.apply(event, object(event.data));
    }
  }

  private apply(event: Json, data: Json): void {
    const turn = this.turn;
    switch (event.type) {
      case "session.inbox.delivered":
        if (turn && !turn.running && turn.inboxId !== null && data.inboxID === turn.inboxId) {
          clearTimeout(this.ackTimer);
          turn.running = true;
          this.emit({ type: "turn_started", native_turn_id: turn.inboxId, input_id: turn.inputId });
        }
        return;
      case "session.inbox.cancelled":
        // Admitted but never delivered: it is not retried, and this generation ends.
        if (turn && !turn.running && turn.inboxId !== null && data.inboxID === turn.inboxId) this.abandon(turn);
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
      case "permission.asked":
        void this.ask(data);
        return;
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

  /**
   * Every request is answered. The running turn's own, from the root or a
   * verified descendant, goes to the supervisor; anything else is refused.
   */
  private async ask(data: Json): Promise<void> {
    const id = data.id;
    const sessionId = data.sessionID;
    if (typeof id !== "string" || !id || typeof sessionId !== "string" || !sessionId || this.pending.has(id)) return;
    const ours = sessionId === this.session || await this.descends(sessionId);
    if (this.terminal) return;
    if (!ours || !this.turn?.running) { await this.refuse(sessionId, id); return; }
    if (this.pending.size >= MAX_PENDING_APPROVALS) { this.fail({ type: "protocol_error" }); return; }
    this.pending.set(id, sessionId);
    const action = typeof data.action === "string" ? data.action : "tool";
    const message = typeof data.message === "string" ? data.message : `OpenCode asks to ${action}.`;
    this.emit({ type: "approval_requested", native_request_id: id, tool: `OpenCode ${action}`,
      summary: approvalSummary(message), detail: JSON.stringify(data, null, 2) });
  }

  /** Whether the conversation's parent chain reaches this worker's root conversation. */
  private async descends(sessionId: string): Promise<boolean> {
    let current = sessionId;
    for (let depth = 0; depth < MAX_ANCESTRY; depth++) {
      let parent: unknown;
      try { parent = object((await this.request("GET", `/api/session/${encodeURIComponent(current)}`)).json.data).parentID; }
      catch { return false; }
      if (typeof parent !== "string" || !parent) return false;
      if (parent === this.session) return true;
      current = parent;
    }
    return false;
  }

  private async refuse(sessionId: string, requestId: string): Promise<void> {
    this.emit({ type: "request_refused", method: "permission.asked" });
    try {
      const result = await this.request("POST",
        `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
        { decision: "reject", message: "No supervised turn asked for this." });
      if (result.status !== 204 && result.status !== 200) this.fail({ type: "protocol_error" });
    } catch {
      this.fail({ type: "protocol_error" });
    }
  }

  /** An admitted prompt that will never run: journalled uncertain, never retried, and the generation ends. */
  private abandon(turn: Turn): void {
    if (this.turn !== turn || this.terminal) return;
    clearTimeout(this.ackTimer);
    this.turn = undefined;
    this.emit({ type: "input", input_id: turn.inputId, outcome: "uncertain" });
    this.fail({ type: "protocol_error" });
  }

  /** Only a turn its own inbox item started can end. */
  private finish(outcome: "success" | "error" | "interrupted"): void {
    const turn = this.turn;
    if (!turn?.running || turn.inboxId === null) return;
    this.turn = undefined;
    for (const id of this.pending.keys()) this.emit({ type: "approval_resolved", native_request_id: id });
    this.pending.clear();
    this.emit({ type: "turn_completed", native_turn_id: turn.inboxId, outcome });
  }

  async submit(input: { input_id: string; text: string; mode: "start_turn" | "steer" }): Promise<InputOutcome> {
    if (input.mode !== "start_turn" || this.turn || !this.session || this.terminal || !this.baseUrl) return "rejected";
    const turn: Turn = { inputId: input.input_id, inboxId: null, running: false };
    this.turn = turn;
    const refused = (): InputOutcome => {
      this.turn = undefined;
      this.release();
      return "rejected";
    };
    // Every prompt goes to the same verified conversation, folder and model.
    let check: Awaited<ReturnType<OpencodeWorkerHandle["checkSession"]>>;
    try { check = await this.checkSession(this.session); } catch { return refused(); }
    if (check !== "ok") {
      const result = refused();
      this.fail(check === "model" ? { type: "state", state: "wrong_auth_mode" } : { type: "protocol_error" });
      return result;
    }
    // It may have been admitted: record that, then end this generation so no
    // later work in the conversation is attributed to another input.
    const uncertain = (): InputOutcome => {
      this.turn = undefined;
      this.held = [];
      this.emit({ type: "input", input_id: input.input_id, outcome: "uncertain" });
      this.fail({ type: "protocol_error" });
      return "uncertain";
    };
    let result: { status: number; json: Json };
    try {
      result = await this.request("POST", `/api/session/${encodeURIComponent(this.session)}/prompt`,
        { text: input.text, delivery: "queue" });
    } catch (error) {
      // A refused connection sent nothing; any other failure may have.
      return (error as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED" ? refused() : uncertain();
    }
    const inbox = object(result.json.data);
    if (result.status === 200 && typeof inbox.id === "string" && inbox.id && inbox.sessionID === this.session) {
      turn.inboxId = inbox.id;
      this.release();
      // Delivery, or another outcome, must follow within a bounded time.
      if (this.turn === turn && !turn.running && !this.terminal) {
        this.ackTimer = setTimeout(() => this.abandon(turn), this.ackTimeoutMs);
      }
      return "written";
    }
    if (result.status === 401) {
      this.fail({ type: "protocol_error" });
      return refused();
    }
    return result.status >= 400 && result.status < 500 ? refused() : uncertain();
  }

  async interrupt(expectedTurnId?: string): Promise<"interrupted" | "not_busy" | "unsupported"> {
    const turn = this.turn;
    if (!turn?.running || !this.session || (expectedTurnId && turn.inboxId !== expectedTurnId)) return "not_busy";
    const result = await this.request("POST", `/api/session/${encodeURIComponent(this.session)}/interrupt`);
    return result.status === 200 && result.json.interrupted === true ? "interrupted" : "not_busy";
  }

  async answerApproval(nativeRequestId: string, decision: "allow" | "deny", note?: string): Promise<void> {
    const sessionId = this.pending.get(nativeRequestId);
    if (decision !== "deny" || !sessionId || !this.session) {
      throw new Error("OpenCode has no matching denial to deliver.");
    }
    const result = await this.request("POST",
      `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(nativeRequestId)}/reply`,
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
  const handle = new OpencodeWorkerHandle(options.generation, password, options.requestTimeoutMs, options.ackTimeoutMs);
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
    const url = await announced;
    await handle.subscribe(timeout);
    const decided = options.beforeSession
      ? await options.beforeSession({ url, authorization: handle.authorizationHeader, cwd: options.cwd,
        signal: options.signal ?? new AbortController().signal })
      : undefined;
    if (options.signal?.aborted) throw new Error("OpenCode start aborted.");
    await handle.openSession(options.cwd, options.resumeSessionId, decided?.model ?? options.model);
    if (options.signal?.aborted) throw new Error("OpenCode start aborted.");
    return handle;
  } catch (error) {
    await handle.stop(100).catch(() => {});
    throw error;
  }
}
