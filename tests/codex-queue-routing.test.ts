import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { deliverCodexQueue } from "../src/native-wake.js";
import { codexControlSocket } from "../src/codex-queue-start.js";

const thread = "00000000-0000-0000-0000-000000000001";
const queued = "00000000-0000-0000-0000-000000000002";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function fixture(status: "idle" | "notLoaded" = "idle") {
  // Keep UNIX socket paths short on macOS. Every endpoint is disposable;
  // even the deliberately wrong default home must never use a live daemon.
  const root = fs.mkdtempSync("/tmp/tt-cqr-");
  const home = path.join(root, "home"), bin = path.join(root, "bin"), capture = path.join(root, "argv.jsonl");
  const socket = codexControlSocket({ CODEX_HOME: home });
  fs.mkdirSync(path.dirname(socket), { recursive: true }); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "codex"), `#!${process.execPath}\nrequire("node:fs").appendFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)) + "\\n");\n`, { mode: 0o700 });
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(root, "wrong-default");
  const server = http.createServer(); const ws = new WebSocketServer({ server });
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  ws.on("connection", client => client.on("message", raw => {
    const r = JSON.parse(raw.toString()); requests.push(r);
    if (r.id === undefined) return;
    const result = r.method === "thread/read" ? { thread: { id: thread, status: { type: status } } }
      : r.method === "thread/turns/list" ? { data: [{ id: "old", status: "completed" }] }
      : r.method === "thread/queue/list" ? { data: [{ id: queued }] }
      : r.method === "thread/queue/start" ? { turn: { id: "started-existing-item" } } : {};
    client.send(JSON.stringify({ id: r.id, result }));
  }));
  cleanup.push(async () => {
    for (const client of ws.clients) client.terminate();
    await new Promise<void>(resolve => ws.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  return { home, socket, requests, env: { PATH: bin, CODEX_HOME: home, CAPTURE: capture },
    argv: () => fs.readFileSync(capture, "utf8").trim().split("\n").map(line => JSON.parse(line)) };
}

describe.skipIf(process.platform === "win32")("Codex queue wake routing", () => {
  test.each(["environment", "explicit socket"])("queues once and starts the stored item on the same configured daemon (%s)", async route => {
    const f = await fixture();
    const result = await deliverCodexQueue({ transport: "codex_queue", address: thread, secret: null,
      text: "one stored envelope", start_queued: true }, { env: f.env, timeout_ms: 2_000,
      ...(route === "explicit socket" ? { codex_socket: f.socket } : {}) });
    expect(result).toEqual({ outcome: "woken" });
    const expected = ["queue", ...(route === "explicit socket" ? ["--remote", `unix://${f.socket}`] : []),
      "--thread", thread, "--message", "one stored envelope"];
    expect(f.argv()).toEqual([expected]);
    expect(f.requests.at(-1)).toMatchObject({ method: "thread/queue/start", params: { threadId: thread, queuedSubmissionId: queued } });
    expect(f.requests.some(r => ["thread/resume", "turn/start", "turn/steer"].includes(r.method))).toBe(false);
    expect(JSON.stringify(f.requests)).not.toContain("one stored envelope");
  });

  test("an unloaded session keeps its one queued envelope without resume, takeover or a second prompt", async () => {
    const f = await fixture("notLoaded");
    expect(await deliverCodexQueue({ transport: "codex_queue", address: thread, secret: null,
      text: "held until native resume", start_queued: true }, { env: f.env, timeout_ms: 2_000 })).toEqual({ outcome: "queued" });
    expect(f.argv()).toHaveLength(1);
    expect(f.requests.map(r => r.method)).toEqual(["initialize", "initialized", "thread/read"]);
  });
});
