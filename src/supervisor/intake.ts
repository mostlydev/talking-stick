import fs from "node:fs";
import net from "node:net";
import path from "node:path";

// The supervisor's control socket, where tt hands it envelopes for the
// workers it owns. One JSON line in, one JSON line out.

export interface IntakeMessage {
  type: "deliver";
  worker_id: string;
  generation: number;
  token: string;
  batch_token: string;
  text: string;
}

export type IntakeAnswer = { outcome: "queued" } | { outcome: "failed"; error: string };

/** A control request from tt supervisor on the same host; the actor is recorded in the audit log. */
export interface ControlMessage {
  type: "control";
  action: "approve" | "deny" | "interrupt";
  actor: string;
  /** The daemon's control token, read from its owner-only file; workers are never given it. */
  token: string;
  approval_id?: string;
  worker_id?: string;
  note?: string;
}

export type ControlAnswer = { ok: true; result: unknown } | { ok: false; error: string };

const MAX_LINE_BYTES = 256 * 1024;

export function startIntakeServer(
  socketPath: string,
  accept: (message: IntakeMessage) => IntakeAnswer | Promise<IntakeAnswer>,
  control?: (message: ControlMessage) => ControlAnswer | Promise<ControlAnswer>
): Promise<{ close(): Promise<void> }> {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(socketPath); } catch { /* none */ }
  // Connections are tracked so closing the server never waits on an idle client.
  const connections = new Set<net.Socket>();
  const server = net.createServer((connection) => {
    connections.add(connection);
    connection.on("close", () => connections.delete(connection));
    // Decoding on the stream keeps a multibyte character split across chunks intact.
    connection.setEncoding("utf8");
    let buffer = "";
    let accepted = false;
    let answered = false;
    const answer = (reply: IntakeAnswer | ControlAnswer) => {
      if (answered) return;
      answered = true;
      connection.end(`${JSON.stringify(reply)}\n`);
    };
    connection.on("error", () => {});
    connection.on("data", (chunk: string) => {
      // One request per connection; anything after it is ignored.
      if (accepted || answered) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) return answer({ outcome: "failed", error: "too_large" });
      const end = buffer.indexOf("\n");
      if (end === -1) return;
      accepted = true;
      let parsed: unknown;
      try {
        parsed = JSON.parse(buffer.slice(0, end));
      } catch {
        return answer({ outcome: "failed", error: "bad_request" });
      }
      const request = parsed as { type?: unknown } | null;
      if (request && typeof request === "object" && request.type === "control") {
        // Control is only on the control socket, never the intake socket workers are given.
        if (!control) return answer({ ok: false, error: "This socket takes no control requests." });
        const command = request as Partial<ControlMessage>;
        if ((command.action !== "approve" && command.action !== "deny" && command.action !== "interrupt") ||
            typeof command.actor !== "string" || typeof command.token !== "string") return answer({ ok: false, error: "bad_request" });
        Promise.resolve().then(() => control(command as ControlMessage))
          .then(answer, (error: unknown) => answer({ ok: false, error: error instanceof Error ? error.message : "internal" }));
        return;
      }
      const message = parsed as Partial<IntakeMessage> | null;
      if (!message || typeof message !== "object" || message.type !== "deliver" || typeof message.worker_id !== "string" ||
          !Number.isInteger(message.generation) || typeof message.token !== "string" ||
          typeof message.batch_token !== "string" || typeof message.text !== "string") {
        return answer({ outcome: "failed", error: "bad_request" });
      }
      // A throw from accept, synchronous or not, answers failed instead of hanging.
      Promise.resolve().then(() => accept(message as IntakeMessage))
        .then(answer, () => answer({ outcome: "failed", error: "internal" }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      fs.chmodSync(socketPath, 0o600);
      resolve({ close: () => new Promise<void>((done) => {
        server.close(() => done());
        for (const connection of connections) connection.destroy();
      }) });
    });
  });
}

/** Sends one control request to a running supervisor. */
export function sendControl(socketPath: string, message: ControlMessage, timeoutMs = 10_000): Promise<ControlAnswer> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    let reply = "";
    const timer = setTimeout(() => { socket.destroy(); resolve({ ok: false, error: "The supervisor did not answer." }); }, timeoutMs);
    socket.on("error", () => { clearTimeout(timer); resolve({ ok: false, error: "No supervisor is running for this data directory." }); });
    socket.on("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", (chunk: string) => { reply += chunk; });
    socket.on("end", () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(reply.trim()) as ControlAnswer); }
      catch { resolve({ ok: false, error: "The supervisor's answer was unreadable." }); }
    });
  });
}
