import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

type RpcMessage = {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message?: string };
};

export function codexControlSocket(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  return path.join(home, "app-server-control", "app-server-control.sock");
}

// The queue command stores the wake text. After an interrupted turn, Codex can
// leave that submission queued indefinitely. Start the stored item, never a
// second copy of its text, only when the thread is loaded and has no active turn.
export function startQueuedCodexThread(
  threadId: string,
  queuedSubmissionId: string,
  socketPath = codexControlSocket(),
  timeoutMs = 3_000
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = new WebSocket(`ws+unix://${socketPath}:/`);
    const finish = (started: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(started);
    };
    const timer = setTimeout(() => {
      socket.terminate();
      finish(false);
    }, timeoutMs);
    const send = (method: string, id: number | undefined, params: Record<string, unknown>) => {
      socket.send(JSON.stringify({ method, ...(id === undefined ? {} : { id }), params }));
    };
    socket.on("open", () => send("initialize", 1, {
      clientInfo: { name: "talking_stick", title: "Talking Stick", version: "0.21.0" },
      capabilities: { experimentalApi: true }
    }));
    socket.on("message", (data) => {
      let message: RpcMessage;
      try { message = JSON.parse(data.toString()) as RpcMessage; }
      catch { finish(false); return; }
      if (!message.id || settled) return;
      if (message.error || !message.result) { finish(false); return; }
      if (message.id === 1) {
        send("initialized", undefined, {});
        send("thread/read", 2, { threadId, includeTurns: false });
      } else if (message.id === 2) {
        const thread = message.result.thread as { id?: string; status?: { type?: string } } | undefined;
        if (thread?.id !== threadId ||
            !["idle", "active"].includes(thread.status?.type ?? "")) { finish(false); return; }
        send("thread/turns/list", 3, { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
      } else if (message.id === 3) {
        const turns = message.result.data as Array<{ status?: string }> | undefined;
        if (!Array.isArray(turns) || turns[0]?.status === "inProgress") { finish(false); return; }
        send("thread/queue/list", 4, { threadId });
      } else if (message.id === 4) {
        const queued = message.result.data as Array<{ id?: string }> | undefined;
        // A native consumer may already have taken this item, or another
        // message may be in front of it. Never start an unrelated submission.
        if (!Array.isArray(queued) || queued[0]?.id !== queuedSubmissionId) { finish(false); return; }
        send("thread/queue/start", 5, { threadId, queuedSubmissionId });
      } else if (message.id === 5) {
        const turn = message.result.turn as { id?: string } | undefined;
        finish(Boolean(turn?.id));
      }
    });
    socket.on("error", () => finish(false));
    socket.on("close", () => finish(false));
  });
}
