import WebSocket from "ws";
import { codexControlSocket } from "../codex-queue-start.js";

export type CodexInterruptResult = "sent" | "idle" | "unavailable" | "failed" | "unconfirmed";

type RpcMessage = {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message?: string };
  method?: string;
  params?: { threadId?: string; turn?: { id?: string; status?: string } };
};

export { codexControlSocket } from "../codex-queue-start.js";

/** Cancel only the currently running turn of an exact Codex thread, without a user message. */
export function interruptCodexThread(
  threadId: string,
  socketPath = codexControlSocket(),
  timeoutMs = 3_000
): Promise<CodexInterruptResult> {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(threadId)) return Promise.resolve("unavailable");
  return new Promise((resolve) => {
    let settled = false;
    let interruptRequested = false;
    let targetTurnId: string | undefined;
    let poll: ReturnType<typeof setTimeout> | undefined;
    let pollId = 5;
    const socket = new WebSocket(`ws+unix://${socketPath}:/`);
    const finish = (result: CodexInterruptResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(poll);
      socket.close();
      resolve(result);
    };
    const timer = setTimeout(() => {
      socket.terminate();
      finish(interruptRequested ? "unconfirmed" : "unavailable");
    }, timeoutMs);
    const send = (method: string, id: number | undefined, params: Record<string, unknown>) => {
      socket.send(JSON.stringify({ method, ...(id === undefined ? {} : { id }), params }));
    };
    const readCompletion = () => {
      if (!settled) send("thread/turns/list", pollId++, {
        threadId, limit: 100, sortDirection: "desc", itemsView: "notLoaded"
      });
    };
    socket.on("open", () => send("initialize", 1, {
      clientInfo: { name: "talking_stick", title: "Talking Stick", version: "0.21.0" },
      capabilities: { experimentalApi: true }
    }));
    socket.on("message", (data) => {
      let message: RpcMessage;
      try { message = JSON.parse(data.toString()) as RpcMessage; }
      catch { finish(interruptRequested ? "unconfirmed" : "failed"); return; }
      if (!settled && interruptRequested && message.method === "turn/completed" &&
          message.params?.threadId === threadId && message.params.turn?.id === targetTurnId) {
        finish(message.params.turn?.status === "interrupted" ? "sent" : "unconfirmed");
        return;
      }
      if (!message.id || settled) return;
      if (message.error || !message.result) { finish(interruptRequested ? "unconfirmed" : "failed"); return; }
      if (message.id === 1) {
        send("initialized", undefined, {});
        send("thread/read", 2, { threadId, includeTurns: false });
      } else if (message.id === 2) {
        const thread = message.result.thread as { id?: string; status?: { type?: string } } | undefined;
        if (thread?.id !== threadId) { finish("failed"); return; }
        if (thread.status?.type !== "active") { finish("idle"); return; }
        send("thread/turns/list", 3, {
          threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded"
        });
      } else if (message.id === 3) {
        const turns = message.result.data as Array<{ id?: string; status?: string }> | undefined;
        const latest = turns?.[0];
        if (!latest?.id || latest.status !== "inProgress") { finish("idle"); return; }
        interruptRequested = true;
        targetTurnId = latest.id;
        send("turn/interrupt", 4, { threadId, turnId: latest.id });
      } else if (message.id === 4) {
        // RPC acceptance requests cancellation; only completion proves stopped.
        // thread/read does not subscribe. Read back the exact turn rather
        // than resume the thread just to receive notifications.
        poll = setTimeout(readCompletion, 25);
      } else if (message.id >= 5) {
        const target = (message.result.data as Array<{ id?: string; status?: string }> | undefined)
          ?.find(turn => turn.id === targetTurnId);
        if (target?.status === "interrupted") { finish("sent"); return; }
        // A missing row is not terminal evidence; keep reading until timeout.
        if (target && target.status !== "inProgress") { finish("unconfirmed"); return; }
        poll = setTimeout(readCompletion, 100);
      }
    });
    socket.on("error", () => finish(interruptRequested ? "unconfirmed" : "unavailable"));
    socket.on("close", () => finish(interruptRequested ? "unconfirmed" : "unavailable"));
  });
}
