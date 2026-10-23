import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { interruptCodexThread } from "../src/cli/codex-interrupt.js";

const threadId = "01a0e1e6-eaba-7db2-aafc-832187d822a0";
const turnId = "01a0e1ed-5b0a-7463-8d71-5016b3f82b4f";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function serverFor(status: "inProgress" | "completed", complete: boolean | "readback" | "missing" = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-codex-interrupt-"));
  const socket = path.join(dir, "control.sock");
  const httpServer = http.createServer();
  const wsServer = new WebSocketServer({ server: httpServer });
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  let cancelled = false;
  let readbacks = 0;
  wsServer.on("connection", (client) => client.on("message", (raw) => {
    const request = JSON.parse(raw.toString()) as {
      id?: number; method: string; params: Record<string, unknown>;
    };
    requests.push({ method: request.method, params: request.params });
    if (request.id === undefined) return;
    const result = request.method === "thread/read"
      ? { thread: { id: threadId, status: { type: "active" } } }
      : request.method === "thread/turns/list"
        ? complete === "missing" && cancelled && readbacks++ < 2 ? { data: [] }
          : { data: [{ id: turnId, status: cancelled && (complete === "readback" || complete === "missing") ? "interrupted" : status }] }
        : {};
    client.send(JSON.stringify({ id: request.id, result }));
    if (request.method === "turn/interrupt") cancelled = true;
    if (request.method === "turn/interrupt" && complete === true) client.send(JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "interrupted" } } }));
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

test("Codex interrupt requests cancellation of only the active turn, without user input", async () => {
  const { socket, requests } = await serverFor("inProgress");
  expect(await interruptCodexThread(threadId, socket)).toBe("sent");
  expect(requests.map((request) => request.method)).toEqual([
    "initialize", "initialized", "thread/read", "thread/turns/list", "turn/interrupt"
  ]);
  expect(requests.at(-1)?.params).toEqual({ threadId, turnId });
  expect(JSON.stringify(requests)).not.toContain("userMessage");
});

test("Codex interrupt leaves a completed turn alone", async () => {
  const { socket, requests } = await serverFor("completed");
  expect(await interruptCodexThread(threadId, socket)).toBe("idle");
  expect(requests.some((request) => request.method === "turn/interrupt")).toBe(false);
});

test("Codex interrupt reports an unavailable socket without sending a fallback message", async () => {
  expect(await interruptCodexThread(threadId, "/tmp/no-such-tt-codex-control.sock", 500)).toBe("unavailable");
});

test("request acceptance alone does not prove the turn stopped", async () => {
  const { socket } = await serverFor("inProgress", false);
  expect(await interruptCodexThread(threadId, socket, 100)).toBe("unconfirmed");
});

test("a non-subscribed control connection confirms cancellation by read-only exact-turn readback", async () => {
  const { socket, requests } = await serverFor("inProgress", "readback");
  expect(await interruptCodexThread(threadId, socket, 500)).toBe("sent");
  expect(requests.filter(request => request.method === "thread/turns/list")).toHaveLength(2);
  expect(requests.some(request => request.method === "thread/resume")).toBe(false);
});

test("a target missing from readback keeps polling until exact interrupted evidence", async () => {
  const { socket, requests } = await serverFor("inProgress", "missing");
  expect(await interruptCodexThread(threadId, socket, 1_000)).toBe("sent");
  expect(requests.filter(request => request.method === "thread/turns/list")).toHaveLength(4);
});
