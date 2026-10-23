import WebSocket from "ws";
import { codexControlSocket } from "./codex-queue-start.js";

export type CodexSteerResult = "steered" | "unsent" | "ambiguous" | "cancelled";

/** No resume/start: target only the live turn of this exact loaded thread.
 * After sending, uncertainty is never permission to queue a second copy.
 */
export function steerCodexThread(input: {
  threadId: string; text: string; clientMessageId: string;
  socketPath?: string; timeoutMs?: number;
  onTarget?(turnId: string): boolean;
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
        try { if (input.onTarget && !input.onTarget(turnId)) { finish("cancelled"); return; } }
        catch { finish("cancelled"); return; }
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

export type CodexTurnStatus = "active" | "ended" | "unknown";

/** Read-only recovery evidence. No subscription, thread resume, or settings. */
export function inspectCodexTurn(threadId: string, turnId: string,
  socketPath = codexControlSocket(), timeoutMs = 1_000): Promise<CodexTurnStatus> {
  return new Promise(resolve => {
    let socket: WebSocket;
    try { socket = new WebSocket(`ws+unix://${socketPath}:/`); }
    catch { resolve("unknown"); return; }
    let settled = false;
    const finish = (status: CodexTurnStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); socket.close(); resolve(status);
    };
    const timer = setTimeout(() => { socket.terminate(); finish("unknown"); }, timeoutMs);
    const send = (id: number | undefined, method: string, params: Record<string, unknown>) =>
      socket.send(JSON.stringify({ ...(id === undefined ? {} : { id }), method, params }));
    socket.on("open", () => send(1, "initialize", { clientInfo: { name: "talking_stick", version: "1" }, capabilities: { experimentalApi: true } }));
    socket.on("message", raw => {
      let message: { id?: number; error?: unknown; result?: Record<string, unknown> };
      try { message = JSON.parse(raw.toString()); } catch { finish("unknown"); return; }
      if (settled || !message.id) return;
      if (message.error || !message.result) { finish("unknown"); return; }
      if (message.id === 1) {
        send(undefined, "initialized", {});
        send(2, "thread/read", { threadId, includeTurns: false });
      } else if (message.id === 2) {
        if ((message.result.thread as { id?: string } | undefined)?.id !== threadId) { finish("unknown"); return; }
        send(3, "thread/turns/list", { threadId, limit: 100, sortDirection: "desc", itemsView: "notLoaded" });
      } else if (message.id === 3) {
        const target = (message.result.data as Array<{ id?: string; status?: string }> | undefined)?.find(turn => turn.id === turnId);
        finish(target?.status === "inProgress" ? "active" :
          target && ["completed", "interrupted", "failed"].includes(target.status ?? "") ? "ended" : "unknown");
      }
    });
    socket.on("error", () => finish("unknown"));
    socket.on("close", () => finish("unknown"));
  });
}
