import { execFile } from "node:child_process";
import net from "node:net";

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
        JSON.stringify({ type: "user", ...(request.interrupt ? { priority: "now" } : {}), message: { role: "user", content: request.text } }) + "\n",
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
