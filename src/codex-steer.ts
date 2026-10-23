import WebSocket from "ws";
import { codexControlSocket } from "./codex-queue-start.js";

export type CodexSteerResult = "steered" | "unsent" | "ambiguous";

/** No resume/start: target only the live turn of this exact loaded thread.
 * After sending, uncertainty is never permission to queue a second copy.
 */
export function steerCodexThread(input: {
  threadId: string; text: string; clientMessageId: string;
  socketPath?: string; timeoutMs?: number;
}): Promise<CodexSteerResult> {
  return new Promise(resolve => {
    let socket: WebSocket;
    try { socket = new WebSocket(`ws+unix://${input.socketPath ?? codexControlSocket()}:/`); }
    catch { resolve("unsent"); return; }
    let sent = false;
    let settled = false;
    let turnId: string | undefined;
    const finish = (result: CodexSteerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(result);
    };
    const timer = setTimeout(() => {
      socket.terminate();
      finish(sent ? "ambiguous" : "unsent");
    }, input.timeoutMs ?? 3_000);
    const send = (id: number | undefined, method: string, params: Record<string, unknown>) => {
      socket.send(JSON.stringify({ ...(id === undefined ? {} : { id }), method, params }));
    };
    socket.on("open", () => send(1, "initialize", {
      clientInfo: { name: "talking_stick", version: "1" }, capabilities: { experimentalApi: true }
    }));
    socket.on("message", raw => {
      if (settled) return;
      let message: { id?: number; result?: Record<string, unknown>; error?: { code?: number; message?: string } };
      try { message = JSON.parse(raw.toString()); }
      catch { finish(sent ? "ambiguous" : "unsent"); return; }
      if (!message.id) return;
      if (message.error) {
        // Only protocol-defined rejections prove the input was not accepted.
        const rejected = message.error.code === -32601 ||
          (message.error.code === -32600 && /no active turn|expected.*turn|turn.*mismatch/i.test(message.error.message ?? ""));
        finish(!sent || rejected ? "unsent" : "ambiguous");
        return;
      }
      if (!message.result) { finish(sent ? "ambiguous" : "unsent"); return; }
      if (message.id === 1) {
        send(undefined, "initialized", {});
        send(2, "thread/read", { threadId: input.threadId, includeTurns: false });
      } else if (message.id === 2) {
        const thread = message.result.thread as { id?: string; status?: { type?: string } } | undefined;
        if (thread?.id !== input.threadId || thread.status?.type !== "active") { finish("unsent"); return; }
        send(3, "thread/turns/list", { threadId: input.threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
      } else if (message.id === 3) {
        const turns = message.result.data as Array<{ id?: string; status?: string }> | undefined;
        const active = turns?.[0];
        if (!active?.id || active.status !== "inProgress") { finish("unsent"); return; }
        turnId = active.id;
        sent = true;
        send(4, "turn/steer", { threadId: input.threadId, expectedTurnId: turnId,
          clientUserMessageId: input.clientMessageId, input: [{ type: "text", text: input.text }] });
      } else if (message.id === 4) {
        finish(message.result.turnId === turnId ? "steered" : "ambiguous");
      }
    });
    socket.on("error", () => finish(sent ? "ambiguous" : "unsent"));
    socket.on("close", () => finish(sent ? "ambiguous" : "unsent"));
  });
}
