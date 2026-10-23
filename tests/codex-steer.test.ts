import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { steerCodexThread } from "../src/codex-steer.js";
import { deliverCodexQueue } from "../src/native-wake.js";

const threadId = "01a0e1e6-eaba-7db2-aafc-832187d822a0";
const turnId = "turn-one";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(mode: "accept" | "idle" | "wrong-thread" | "changed-turn" | "disconnect" | "unknown-error") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-steer-"));
  const socketPath = path.join(dir, "s.sock");
  const server = http.createServer();
  const ws = new WebSocketServer({ server });
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  ws.on("connection", client => client.on("message", raw => {
    const request = JSON.parse(raw.toString());
    requests.push(request);
    if (!request.id) return;
    let result = {};
    if (request.method === "thread/read") result = { thread: { id: mode === "wrong-thread" ? "other" : threadId, status: { type: mode === "idle" ? "idle" : "active" } } };
    if (request.method === "thread/turns/list") result = { data: [{ id: turnId, status: "inProgress" }] };
    if (request.method === "turn/steer") {
      if (mode === "disconnect") { client.close(); return; }
      if (mode === "changed-turn" || mode === "unknown-error") {
        client.send(JSON.stringify({ id: request.id, error: { code: mode === "changed-turn" ? -32600 : -32603,
          message: mode === "changed-turn" ? "expected turn id does not match active turn" : "unknown internal failure" } })); return;
      }
      result = { turnId };
    }
    client.send(JSON.stringify({ id: request.id, result }));
  }));
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  cleanup.push(async () => {
    for (const client of ws.clients) client.terminate();
    await new Promise<void>(resolve => ws.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const queueMarker = path.join(dir, "queued");
  fs.writeFileSync(path.join(dir, "codex"), `#!/bin/sh\nprintf queued > '${queueMarker}'\n`, { mode: 0o755 });
  const request = { transport: "codex_queue" as const, address: threadId, secret: null, text: "operator correction", steer: true };
  const options = { codex_socket: socketPath, timeout_ms: 500, env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` } };
  return { dir, socketPath, requests, queueMarker, request, options };
}

test("steering appends input to the exact live turn without starting or queueing a turn", async () => {
  const f = await fixture("accept");
  expect(await deliverCodexQueue(f.request, f.options)).toEqual({ outcome: "steered" });
  const steer = f.requests.find(request => request.method === "turn/steer")!;
  expect(steer.params).toMatchObject({ threadId, expectedTurnId: turnId, input: [{ type: "text", text: "operator correction" }] });
  expect(steer.params.clientUserMessageId).toMatch(/^tt-[a-f0-9]{64}$/);
  expect(fs.existsSync(f.queueMarker)).toBe(false);
  expect(f.requests.some(request => request.method === "thread/resume" || request.method === "turn/start")).toBe(false);
});

test.each(["idle", "wrong-thread", "changed-turn"] as const)("a definite rejection permits one queue fallback: %s", async mode => {
  const f = await fixture(mode);
  expect(await deliverCodexQueue(f.request, f.options)).toEqual({ outcome: "queued" });
  expect(fs.readFileSync(f.queueMarker, "utf8")).toBe("queued");
  if (mode !== "changed-turn") expect(f.requests.some(request => request.method === "turn/steer")).toBe(false);
});

test.each(["disconnect", "unknown-error"] as const)("post-send uncertainty never queues a duplicate: %s", async mode => {
  const f = await fixture(mode);
  expect(await deliverCodexQueue(f.request, f.options)).toEqual({ outcome: "ambiguous", error: "codex_steer_unconfirmed" });
  expect(fs.existsSync(f.queueMarker)).toBe(false);
});

test("an unavailable control socket proves no steer was sent", async () => {
  expect(await steerCodexThread({ threadId, text: "test", clientMessageId: "id", socketPath: "/tmp/no-tt-steer.sock", timeoutMs: 100 })).toBe("unsent");
});
