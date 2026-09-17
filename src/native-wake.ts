import { execFile } from "node:child_process";
import net from "node:net";
import type { RoomEvent } from "./types.js";

export type NativeWakeTransportName = "claude_inbox" | "codex_queue" | "cmux";
export type NativeWakeReason = "message" | "interrupt" | "turn" | "room_update";
export type NativeWakeState = "woken" | "queued" | "ambiguous";

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
}

// failed: the harness definitely did not receive the wake, so a fallback may
// run. ambiguous: the wake may have landed, so no fallback runs. error is a
// fixed code: raw child output can echo the socket path or token.
export interface NativeWakeResult {
  outcome: NativeWakeState | "failed";
  error?: string;
}

export interface NativeWakeTransport {
  deliver(request: NativeWakeRequest): NativeWakeResult | Promise<NativeWakeResult>;
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

// Compact, attributed plain text: an agent reads a two-line chat message for
// a few dozen tokens instead of a JSON document. Every line of room content is
// indented, so nothing a sender writes can start a line that looks like an
// event header or the closing boundary. Content stays untrusted data.
export function formatNativeEventText(input: {
  token: string; room_id: string; path: string; recipient: string; events: RoomEvent[];
}): string | null {
  if (input.events.length === 0 || input.events.length > 32) return null;
  const quote = (text: string) => text.replace(/\r\n?/g, "\n").replace(/\s+$/, "").split("\n").map((line) => `  ${line}`);
  const lines = [`[talking-stick] room ${input.path} · ack: tt ack ${input.token} --json`];
  for (const event of input.events) {
    const payload = (event.payload ?? {}) as { body?: unknown; delivery_hint?: unknown; recipients?: unknown };
    const recipients = Array.isArray(payload.recipients) ? payload.recipients.filter((id): id is string => typeof id === "string") : [];
    const route = event.to_agent_id === input.recipient ? "you"
      : event.to_agent_id ? event.to_agent_id
      : recipients.length > 0 ? recipients.map((id) => (id === input.recipient ? "you" : id)).join(", ")
      : "room";
    const kind = event.event_type === "message_sent" ? "" : `${event.event_type} `;
    const urgent = payload.delivery_hint === "interrupt" ? " ‼ urgent" : "";
    const arrow = event.event_type === "message_sent" || event.to_agent_id || recipients.length > 0 ? ` → ${route}` : "";
    lines.push(`#${event.event_seq} ${kind}${event.from_agent_id ?? "system"}${arrow}${urgent}`);
    if (typeof payload.body === "string") lines.push(...quote(payload.body));
    if (event.handoff) {
      lines.push(...quote(`status: ${event.handoff.status}`), ...quote(`next: ${event.handoff.next_action}`));
      const artifacts = (event.handoff.artifacts ?? []).map((artifact) =>
        `${artifact.path}${artifact.lines?.length ? `:${artifact.lines.join(",")}` : ""}${artifact.note ? ` (${artifact.note})` : ""}`);
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
}

export function createSystemNativeWakeTransport(options: NativeWakeOptions = {}): NativeWakeTransport {
  return {
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
    const timer = setTimeout(() => finish({ outcome: "ambiguous", error: "claude_inbox_timeout" }),
      options.timeout_ms ?? CLAUDE_INBOX_TIMEOUT_MS);
    socket.on("error", (error: NodeJS.ErrnoException) => {
      const definite = !written && ["ENOENT", "ECONNREFUSED", "EACCES"].includes(error.code ?? "");
      finish({ outcome: definite ? "failed" : "ambiguous", error: definite ? "claude_inbox_unreachable" : "claude_inbox_write_failed" });
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
    socket.on("close", () => finish({ outcome: "ambiguous", error: "claude_inbox_closed" }));
  });
}

export function deliverCodexQueue(request: NativeWakeRequest, options: NativeWakeOptions = {}): Promise<NativeWakeResult> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.address)) {
    return Promise.resolve({ outcome: "failed", error: "invalid_codex_thread" });
  }
  return new Promise((resolve) => {
    const child = execFile("codex", ["queue", "--thread", request.address, "--message", request.text], {
      encoding: "utf8", timeout: options.timeout_ms ?? CODEX_QUEUE_TIMEOUT_MS,
      killSignal: "SIGKILL", maxBuffer: 64 * 1024, windowsHide: true,
      env: withoutClaudeInboxCredentials(options.env ?? process.env)
    }, (error, _stdout, stderr) => {
      if (!error) { resolve({ outcome: "queued" }); return; }
      if (error.code === "ENOENT" || error.code === "EACCES") {
        resolve({ outcome: "failed", error: "codex_unavailable" }); return;
      }
      if (!error.killed && !error.signal && typeof error.code === "number" &&
        /thread\/queue\/add failed: failed to read thread: (?:invalid thread-store request: )?no rollout found for thread id [0-9a-f-]{36}(?:\s|$)/i.test(stderr)) {
        resolve({ outcome: "failed", error: "codex_thread_not_found" }); return;
      }
      resolve({ outcome: "ambiguous", error: error.killed || error.signal ? "codex_queue_timeout" : "codex_queue_failed" });
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
