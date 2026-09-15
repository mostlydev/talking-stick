import { execFileSync } from "node:child_process";

export type NativeWakeTransportName = "claude_inbox" | "codex_queue";
export type NativeWakeReason = "message" | "turn" | "room_update";
export type NativeWakeState = "woken" | "queued" | "ambiguous";

export const CLAUDE_INBOX_TIMEOUT_MS = 2_000;
export const CODEX_QUEUE_TIMEOUT_MS = 10_000;

// Native transports in delivery preference order.
export const NATIVE_WAKE_TRANSPORTS: readonly NativeWakeTransportName[] = [
  "claude_inbox",
  "codex_queue"
];

export interface NativeWakeRegistration {
  transport: NativeWakeTransportName;
  address: string;
  secret: string | null;
}

export interface NativeWakeRequest extends NativeWakeRegistration {
  text: string;
}

// failed: the harness definitely did not receive the wake, so a fallback may
// run. ambiguous: the wake may have landed, so no fallback runs. error is a
// fixed code: raw child output can echo the socket path or token.
export interface NativeWakeResult {
  outcome: NativeWakeState | "failed";
  error?: string;
}

export interface NativeWakeTransport {
  deliver(request: NativeWakeRequest): NativeWakeResult;
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

export type NativeWakeExec = (
  file: string,
  args: readonly string[],
  options: {
    input?: string;
    timeout: number;
    encoding: "utf8";
    stdio: ["pipe", "pipe", "pipe"];
  }
) => string;

// Exit 3 means the socket could not be reached; nothing was written.
const CLAUDE_INBOX_SCRIPT = `
const net = require("node:net");
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const { socket, token, text } = JSON.parse(raw);
  let connected = false;
  const conn = net.createConnection(socket);
  conn.on("error", (error) => {
    process.stderr.write(String(error.code || error.message));
    process.exit(connected ? 4 : 3);
  });
  conn.on("connect", () => {
    connected = true;
    const lines =
      JSON.stringify({ type: "auth", token }) + "\\n" +
      JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\\n";
    conn.end(lines, () => process.exit(0));
  });
});
`;

const CODEX_THREAD_NOT_FOUND = /no rollout found|thread not found/i;

export function createSystemNativeWakeTransport(
  exec: NativeWakeExec = (file, args, options) =>
    execFileSync(file, args, options)
): NativeWakeTransport {
  return {
    deliver(request) {
      if (request.transport === "claude_inbox") {
        return deliverClaudeInbox(exec, request);
      }
      return deliverCodexQueue(exec, request);
    }
  };
}

function deliverClaudeInbox(
  exec: NativeWakeExec,
  request: NativeWakeRequest
): NativeWakeResult {
  try {
    // The token travels over stdin so it never appears in a process listing.
    exec(process.execPath, ["-e", CLAUDE_INBOX_SCRIPT], {
      input: JSON.stringify({
        socket: request.address,
        token: request.secret,
        text: request.text
      }),
      timeout: CLAUDE_INBOX_TIMEOUT_MS,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"]
    });
    return { outcome: "queued" };
  } catch (error) {
    const failure = describeExecFailure(error);
    if (failure.timed_out) {
      return { outcome: "ambiguous", error: "claude_inbox_timeout" };
    }
    if (failure.status === 3 || failure.spawn_error) {
      return { outcome: "failed", error: "claude_inbox_unreachable" };
    }
    return { outcome: "ambiguous", error: "claude_inbox_write_failed" };
  }
}

function deliverCodexQueue(
  exec: NativeWakeExec,
  request: NativeWakeRequest
): NativeWakeResult {
  try {
    // codex queue prints the same "Queued message" line whether or not the
    // thread started a turn, so success is always reported as queued.
    exec(
      "codex",
      ["queue", "--thread", request.address, "--message", request.text],
      {
        timeout: CODEX_QUEUE_TIMEOUT_MS,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"]
      }
    );
    return { outcome: "queued" };
  } catch (error) {
    const failure = describeExecFailure(error);
    if (failure.timed_out) {
      return { outcome: "ambiguous", error: "codex_queue_timeout" };
    }
    if (failure.spawn_error) {
      return { outcome: "failed", error: "codex_unavailable" };
    }
    if (CODEX_THREAD_NOT_FOUND.test(failure.stderr)) {
      return { outcome: "failed", error: "codex_thread_not_found" };
    }
    return { outcome: "ambiguous", error: "codex_queue_failed" };
  }
}

function describeExecFailure(error: unknown): {
  timed_out: boolean;
  spawn_error: boolean;
  status: number | null;
  stderr: string;
} {
  const failure = error as {
    code?: string;
    signal?: string | null;
    status?: number | null;
    stderr?: string | Buffer;
  };
  return {
    timed_out: failure.code === "ETIMEDOUT" || failure.signal === "SIGTERM",
    spawn_error: failure.code === "ENOENT" || failure.code === "EACCES",
    status: typeof failure.status === "number" ? failure.status : null,
    stderr: failure.stderr ? String(failure.stderr) : ""
  };
}
