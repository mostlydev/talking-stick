import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import { attachmentInstruction, payloadAttachments } from "./attachments.js";
import { codexControlSocket, startQueuedCodexThread } from "./codex-queue-start.js";
import { inspectCodexTurn, steerCodexThread, type CodexTurnStatus } from "./codex-steer.js";
import type { RoomEvent } from "./types.js";

export type NativeWakeTransportName = "claude_inbox" | "codex_queue" | "cmux";
export type NativeWakeReason = "message" | "interrupt" | "turn" | "room_update";
export type NativeWakeState = "woken" | "queued" | "steered" | "ambiguous";

export const CLAUDE_INBOX_TIMEOUT_MS = 2_000;
export const CODEX_QUEUE_TIMEOUT_MS = 10_000;

// Native transports in delivery preference order.
export const NATIVE_WAKE_TRANSPORTS: readonly NativeWakeTransportName[] = [
  "claude_inbox",
  "codex_queue",
  "cmux"
];

export interface NativeWakeRegistration {
  transport: NativeWakeTransportName;
  address: string;
  secret: string | null;
}

export interface NativeWakeRequest extends NativeWakeRegistration {
  text: string;
  interrupt?: boolean;
  steer?: boolean;
  start_queued?: boolean;
  /** Persist and revalidate the exact target before any steering input is sent. */
  on_steer_target?(turnId: string): boolean;
  can_queue?(): boolean;
}

// failed: the harness definitely did not receive the wake, so a fallback may
// run. ambiguous: the wake may have landed, so no fallback runs. error is a
// fixed code: raw child output can echo the socket path or token.
export interface NativeWakeResult {
  outcome: NativeWakeState | "failed";
  error?: string;
  /** Where it failed and the system's reason, e.g. "connect:EPERM" or
   * "exit:1 rpc:-32603"; never message text or credentials. */
  detail?: string;
  /** A definite failure caused by this sender's own environment (permission
   * denied, codex not launchable), which another local process may not hit. */
  local?: boolean;
}

export interface NativeWakeTransport {
  deliver(request: NativeWakeRequest): NativeWakeResult | Promise<NativeWakeResult>;
  inspectCodexTurn?(threadId: string, turnId: string): Promise<CodexTurnStatus>;
}

export function detectNativeWakeEndpoints(
  env: NodeJS.ProcessEnv,
  identity: { agent_id: string; harness_session_id?: string | null }
): NativeWakeRegistration[] {
  const harness = identity.agent_id.split(":", 1)[0];
  const endpoints: NativeWakeRegistration[] = [];
  const socket = env.CLAUDE_CODE_MESSAGING_SOCKET?.trim();
  const token = env.CLAUDE_CODE_MESSAGING_TOKEN?.trim();
  if (harness === "claude" && env.CLAUDECODE === "1" && socket && token) {
    endpoints.push({ transport: "claude_inbox", address: socket, secret: token });
  }
  const thread = env.CODEX_THREAD_ID?.trim();
  if (
    harness === "codex" &&
    thread &&
    (identity.harness_session_id === thread ||
      identity.harness_session_id === `harness:${thread}`)
  ) {
    endpoints.push({ transport: "codex_queue", address: thread, secret: null });
  }
  return endpoints;
}

export function formatNativeWakeText(input: {
  reason: NativeWakeReason;
  sender: string | null;
  path: string;
}): string {
  const sender = sanitizeWakeLabel(input.sender ?? "") || "a room member";
  const place = sanitizeWakeLabel(input.path, 200) || "the room";
  switch (input.reason) {
    case "interrupt":
      return `[talking-stick] URGENT room message from ${sender} in ${place}. Run \`tt wait --json\` now to read it.`;
    case "message":
      return `[talking-stick] New message from ${sender} in ${place}. Run \`tt wait --json\` to read it.`;
    case "turn":
      return `[talking-stick] ${sender} handed you the turn in ${place}. Run \`tt wait --json\` to take it.`;
    case "room_update":
      return `[talking-stick] Room update in ${place}. Run \`tt wait --json\` to check it.`;
  }
}

// Agents copy the token into every acknowledgement, so it is short: eight
// characters from a 32-symbol alphabet without look-alikes (l, o, 0, 1).
// The service rejects a token already held by a stored batch.
const DELIVERY_TOKEN_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

export function newDeliveryToken(): string {
  return [...randomBytes(8)].map((byte) => DELIVERY_TOKEN_ALPHABET[byte & 31]).join("");
}

// Compact, attributed plain text: an agent reads a two-line chat message for
// a few dozen tokens instead of a JSON document. Every line of room content is
// indented, so nothing a sender writes can start a line that looks like an
// event header or the closing boundary. Content stays untrusted data.
export function formatNativeEventText(input: {
  token: string; room_id: string; path: string; recipient: string; events: RoomEvent[];
}): string | null {
  if (input.events.length === 0 || input.events.length > 32) return null;
  const quote = (text: string) => text.replace(/\r\n?/g, "\n").replace(/\s+$/, "").split("\n").map((line) => `  ${line}`);
  const lines = [`[talking-stick] room ${input.path} · ack: tt ack ${input.token}`];
  for (const event of input.events) {
    const payload = (event.payload ?? {}) as { body?: unknown; delivery_hint?: unknown; recipients?: unknown;
      request_id?: unknown; in_reply_to?: unknown };
    const recipients = Array.isArray(payload.recipients) ? payload.recipients.filter((id): id is string => typeof id === "string") : [];
    // Request ids are generated tokens, never sender text, so they are safe
    // in the header line.
    const requestId = typeof payload.request_id === "string" ? payload.request_id : null;
    const replyTo = typeof payload.in_reply_to === "string" ? payload.in_reply_to : null;
    const route = replyTo ? `visitor (request ${replyTo})`
      : event.to_agent_id === input.recipient ? "you"
      : event.to_agent_id ? event.to_agent_id
      : recipients.length > 0 ? recipients.map((id) => (id === input.recipient ? "you" : id)).join(", ")
      : "room";
    const kind = requestId ? "visitor " : event.event_type === "message_sent" ? "" : `${event.event_type} `;
    const urgent = payload.delivery_hint === "interrupt" ? " ‼ urgent" : "";
    const arrow = event.event_type === "message_sent" || event.to_agent_id || recipients.length > 0 ? ` → ${route}` : "";
    const reply = requestId ? ` · reply: tt msg reply ${requestId} --stdin` : "";
    lines.push(`#${event.event_seq} ${kind}${event.from_agent_id ?? "system"}${arrow}${urgent}${reply}`);
    if (typeof payload.body === "string" && payload.body.length > 0) lines.push(...quote(payload.body));
    for (const [index, attachment] of payloadAttachments(event.payload).entries()) lines.push(...quote(attachmentInstruction(attachment, index)));
    if (event.handoff) {
      lines.push(...quote(`status: ${event.handoff.status}`), ...quote(`next: ${event.handoff.next_action}`));
      // Handoffs written with tt release --stdin often list artifacts as plain
      // path strings rather than objects; render whichever arrived.
      const artifacts = ((event.handoff.artifacts ?? []) as unknown[]).map((artifact) => {
        if (typeof artifact === "string") return artifact;
        const entry = (artifact ?? {}) as { path?: unknown; lines?: unknown; note?: unknown };
        const where = typeof entry.path === "string" ? entry.path : JSON.stringify(artifact);
        const lines = Array.isArray(entry.lines) && entry.lines.length ? `:${entry.lines.join(",")}` : "";
        return `${where}${lines}${typeof entry.note === "string" ? ` (${entry.note})` : ""}`;
      });
      if (artifacts.length) lines.push(...quote(`artifacts: ${artifacts.join("; ")}`));
      for (const question of event.handoff.open_questions ?? []) lines.push(...quote(`question: ${question}`));
      for (const rule of event.handoff.do_not ?? []) lines.push(...quote(`do not: ${rule}`));
    }
    if (event.reason) lines.push(...quote(`reason: ${event.reason}`));
  }
  // The skill explains that content is untrusted and ack grants no turn; the
  // boundary itself only needs to be unambiguous.
  lines.push("[/talking-stick]");
  const text = lines.join("\n");
  return Buffer.byteLength(text, "utf8") > 24 * 1024 ? null : text;
}

function sanitizeWakeLabel(value: string, max = 64): string {
  return value
    .replace(/[^\p{L}\p{N} ._:@/~+-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export interface NativeWakeOptions {
  timeout_ms?: number;
  env?: NodeJS.ProcessEnv;
  codex_socket?: string;
}

export function createSystemNativeWakeTransport(options: NativeWakeOptions = {}): NativeWakeTransport {
  return {
    inspectCodexTurn: (threadId, turnId) => inspectCodexTurn(threadId, turnId,
      options.codex_socket ?? codexControlSocket(options.env), options.timeout_ms ?? 1_000),
    deliver(request) {
      if (request.transport === "claude_inbox") return deliverClaudeInbox(request, options);
      if (request.transport === "codex_queue") return deliverCodexQueue(request, options);
      return { outcome: "failed", error: "unsupported_native_transport" };
    }
  };
}

export function deliverClaudeInbox(request: NativeWakeRequest, options: NativeWakeOptions = {}): Promise<NativeWakeResult> {
  return new Promise((resolve) => {
    let written = false;
    let settled = false;
    const socket = net.createConnection(request.address);
    const finish = (result: NativeWakeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    // Before the socket connects, no byte can have reached Claude. A missing or
    // refusing Unix socket means the session is gone; any other early failure (a
    // denied connect, a hung one) may be this sender's own, so another local
    // process may still get through.
    // Windows pipe access denial can surface as ECONNREFUSED under Bun. Keep
    // that wake pending for an unsandboxed sender instead of declaring it gone.
    const windowsPipe = request.address.toLowerCase().startsWith("\\\\.\\pipe\\");
    const unsent = (code: string): NativeWakeResult => ({ outcome: "failed", error: "claude_inbox_unreachable",
      detail: `connect:${code}`, ...(code === "ENOENT" || (code === "ECONNREFUSED" && !windowsPipe) ? {} : { local: true }) });
    const timer = setTimeout(() => finish(written
      ? { outcome: "ambiguous", error: "claude_inbox_timeout", detail: "write:timeout" } : unsent("timeout")),
      options.timeout_ms ?? CLAUDE_INBOX_TIMEOUT_MS);
    socket.on("error", (error: NodeJS.ErrnoException) => {
      const code = error.code ?? "unknown";
      finish(written ? { outcome: "ambiguous", error: "claude_inbox_write_failed", detail: `write:${code}` } : unsent(code));
    });
    socket.on("connect", () => {
      written = true;
      socket.end(
        JSON.stringify({ type: "auth", token: request.secret }) + "\n" +
        // Interrupts ask for "next", not "now": in interactive Claude Code "now"
        // doesn't abort a running tool (verified live), and other hosts may abort
        // one. "next" steers the active turn at its next tool boundary.
        JSON.stringify({ type: "user", ...((request.interrupt || request.steer) ? { priority: "next" } : {}), message: { role: "user", content: request.text } }) + "\n",
        () => finish({ outcome: "queued" })
      );
    });
    socket.on("close", () => finish(written
      ? { outcome: "ambiguous", error: "claude_inbox_closed", detail: "write:closed" } : unsent("closed")));
  });
}

export async function deliverCodexQueue(request: NativeWakeRequest, options: NativeWakeOptions = {}): Promise<NativeWakeResult> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.address)) {
    return Promise.resolve({ outcome: "failed", error: "invalid_codex_thread" });
  }
  if (request.steer || request.interrupt) {
    const result = await steerCodexThread({ threadId: request.address, text: request.text,
      clientMessageId: `tt-${createHash("sha256").update(request.text).digest("hex")}`,
      socketPath: options.codex_socket ?? codexControlSocket(options.env), timeoutMs: options.timeout_ms,
      onTarget: request.on_steer_target });
    if (result === "steered") return { outcome: "steered" };
    if (result === "ambiguous") return { outcome: "ambiguous", error: "codex_steer_unconfirmed" };
    if (result === "cancelled") return { outcome: "failed", error: "native_wake_unavailable", local: true };
    // The thread is idle, the method unsupported, or no steer bytes were sent.
    // Queuing is safe only in these definitely-unsent cases.
  }
  if (request.can_queue && !request.can_queue()) return { outcome: "failed", error: "native_wake_unavailable", local: true };
  return new Promise((resolve) => {
    const child = execFile("codex", ["queue", "--thread", request.address, "--message", request.text], {
      encoding: "utf8", timeout: options.timeout_ms ?? CODEX_QUEUE_TIMEOUT_MS,
      killSignal: "SIGKILL", maxBuffer: 64 * 1024, windowsHide: true,
      env: withoutClaudeInboxCredentials(options.env ?? process.env)
    }, (error, _stdout, stderr) => {
      if (!error) {
        if (!request.start_queued) { resolve({ outcome: "queued" }); return; }
        void startQueuedCodexThread(request.address, undefined, options.timeout_ms ?? 3_000)
          .then((started) => resolve({ outcome: started ? "woken" : "queued" }))
          .catch(() => resolve({ outcome: "queued" }));
        return;
      }
      // A child that never started cannot have queued anything.
      if (typeof error.code === "string" && ["ENOENT", "EACCES", "EPERM"].includes(error.code)) {
        resolve({ outcome: "failed", error: "codex_unavailable", detail: `spawn:${error.code}`, local: true }); return;
      }
      const rpc = /\(code (-?\d{1,6})\)/.exec(stderr)?.[1];
      const detail = error.killed || error.signal ? `signal:${error.signal ?? "SIGKILL"}`
        : `exit:${String(error.code)}${rpc ? ` rpc:${rpc}` : ""}`;
      if (!error.killed && !error.signal && typeof error.code === "number" &&
        /thread\/queue\/add failed: failed to read thread: (?:invalid thread-store request: )?no rollout found for thread id [0-9a-f-]{36}(?:\s|$)/i.test(stderr)) {
        resolve({ outcome: "failed", error: "codex_thread_not_found", detail }); return;
      }
      resolve({ outcome: "ambiguous", error: error.killed || error.signal ? "codex_queue_timeout" : "codex_queue_failed", detail });
    });
    child.stdin?.end();
  });
}

// The sender may itself run inside Claude Code; its own inbox credentials must
// not leak into the codex child.
function withoutClaudeInboxCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const key of Object.keys(copy)) {
    if (key.startsWith("CLAUDE_CODE_MESSAGING_")) delete copy[key];
  }
  return copy;
}
