import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { startQueuedCodexThread } from "../src/codex-queue-start.js";

const threadId = "01a0e1e6-eaba-7db2-aafc-832187d822a0";
const queuedId = "01a0e353-509b-7932-9915-b082b8169a4c";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function serverFor(threadStatus: "idle" | "active" | "notLoaded", turnStatus: "completed" | "inProgress") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-codex-queue-start-"));
  const socket = path.join(dir, "control.sock");
  const httpServer = http.createServer();
  const wsServer = new WebSocketServer({ server: httpServer });
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  wsServer.on("connection", (client) => client.on("message", (raw) => {
    const request = JSON.parse(raw.toString()) as {
      id?: number; method: string; params: Record<string, unknown>;
    };
    requests.push({ method: request.method, params: request.params });
    if (request.id === undefined) return;
    const result = request.method === "thread/read"
      ? { thread: { id: threadId, status: { type: threadStatus } } }
      : request.method === "thread/turns/list"
        ? { data: [{ status: turnStatus }] }
        : request.method === "thread/queue/list"
          ? { data: [{ id: queuedId }] }
          : request.method === "thread/queue/start"
            ? { turn: { id: "new-turn" } }
            : {};
    client.send(JSON.stringify({ id: request.id, result }));
  }));
  await new Promise<void>((resolve) => httpServer.listen(socket, resolve));
  cleanup.push(async () => {
    for (const client of wsServer.clients) client.terminate();
    await new Promise<void>((resolve) => wsServer.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { socket, requests };
}

test("starts an existing queued submission on an idle loaded Codex thread", async () => {
  const { socket, requests } = await serverFor("idle", "completed");
  expect(await startQueuedCodexThread(threadId, queuedId, socket)).toBe(true);
  expect(requests.map((request) => request.method)).toEqual([
    "initialize", "initialized", "thread/read", "thread/turns/list", "thread/queue/list", "thread/queue/start"
  ]);
  expect(requests.at(-1)?.params).toEqual({ threadId, queuedSubmissionId: queuedId });
  expect(JSON.stringify(requests)).not.toContain("turn/start");
});

test("does not start a queued submission on an active or unloaded thread", async () => {
  const active = await serverFor("active", "inProgress");
  expect(await startQueuedCodexThread(threadId, queuedId, active.socket)).toBe(false);
  expect(active.requests.some((request) => request.method === "thread/queue/start")).toBe(false);
  const unloaded = await serverFor("notLoaded", "completed");
  expect(await startQueuedCodexThread(threadId, queuedId, unloaded.socket)).toBe(false);
  expect(unloaded.requests.some((request) => request.method === "thread/queue/start")).toBe(false);
});

test("a loaded thread with no in-progress turn can start its existing queue", async () => {
  const { socket, requests } = await serverFor("active", "completed");
  expect(await startQueuedCodexThread(threadId, queuedId, socket)).toBe(true);
  expect(requests.at(-1)?.method).toBe("thread/queue/start");
});

test("an unavailable Codex control socket leaves the queue alone", async () => {
  expect(await startQueuedCodexThread(threadId, queuedId, "/tmp/no-such-tt-codex-control.sock", 500)).toBe(false);
});
