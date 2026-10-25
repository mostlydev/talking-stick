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

const MAX_LINE_BYTES = 256 * 1024;

export function startIntakeServer(
  socketPath: string,
  accept: (message: IntakeMessage) => IntakeAnswer | Promise<IntakeAnswer>
): Promise<{ close(): Promise<void> }> {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(socketPath); } catch { /* none */ }
  const server = net.createServer((connection) => {
    // Decoding on the stream keeps a multibyte character split across chunks intact.
    connection.setEncoding("utf8");
    let buffer = "";
    let accepted = false;
    let answered = false;
    const answer = (reply: IntakeAnswer) => {
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
      resolve({ close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}
