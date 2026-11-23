import { UnsentInputError, type ManagedProcess } from "./process.js";

export type AcpObject = Record<string, unknown>;
export function acpObject(value: unknown): AcpObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as AcpObject : {};
}

export class AcpError extends Error {
  constructor(message: string, readonly phase: "unsent" | "uncertain" | "rejected", readonly auth = false) {
    super(message);
  }
}

function authenticationError(value: unknown): boolean {
  return /unauth|authentication|not logged|401|login required/i.test(JSON.stringify(value ?? {}));
}

/** One JSON-RPC connection to a managed ACP process. */
export class AcpRpc {
  process: ManagedProcess | null = null;
  private id = 0;
  private pending = new Map<number, { resolve(value: AcpObject): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  request(method: string, params: AcpObject, timeoutMs: number, onWritten?: () => void): Promise<AcpObject> {
    if (!this.process?.alive()) return Promise.reject(new AcpError("ACP is not connected.", "unsent"));
    if (this.pending.size >= 64) return Promise.reject(new AcpError("ACP has too many pending requests.", "unsent"));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AcpError("ACP request is unconfirmed.", "uncertain"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.process!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params })).then(onWritten).catch((error) => {
        const waiting = this.pending.get(id);
        if (!waiting) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof UnsentInputError ? new AcpError("ACP request was not sent.", "unsent") : new AcpError("ACP write is unconfirmed.", "uncertain"));
      });
    });
  }
  complete(message: AcpObject): void {
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error !== undefined) {
      // A raw server error can carry user or auth data; keep only its kind.
      pending.reject(new AcpError("ACP rejected the request.", "rejected", authenticationError(message.error)));
    } else if (message.result !== undefined) pending.resolve(acpObject(message.result));
    else pending.reject(new AcpError("ACP returned an invalid response.", "uncertain"));
  }
  close(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AcpError("ACP connection ended.", "uncertain"));
    }
    this.pending.clear();
  }
}
