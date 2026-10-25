import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { CodexAdapter, resolveCodexExecutable } from "../src/supervisor/adapters/codex.js";
import { workerEnvironment } from "../src/supervisor/adapters/process.js";
import type { WorkerEvent, WorkerHandle, WorkerSpec } from "../src/supervisor/adapter.js";
import { createSystemProcessInspector } from "../src/process-utils.js";
import { createProcessEvidence, readProcessStartEvidence } from "../src/supervisor-process-evidence.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!done()) { if (Date.now() > deadline) throw new Error("Protocol fixture did not settle."); await new Promise(r => setTimeout(r, 5)); }
}
function fixture(mode = "") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-codex-adapter-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const trace = path.join(root, "trace.jsonl");
  const spec: WorkerSpec = { worker_id: "w1", harness: "codex", cwd: root,
    permissions: { harness: "codex", sandbox: "workspace-write", approval: "on-request" },
    env: [{ name: "FIXTURE_MODE", from: "literal", value: mode }, { name: "FIXTURE_TRACE", from: "literal", value: trace }],
    supervisor_env: { TALKING_STICK_DATA_DIR: path.join(root, "data"), TT_SUPERVISOR_ENDPOINT: "/tmp/test.sock#w1@1", TT_SUPERVISOR_TOKEN: "delivery" } };
  const adapter = new CodexAdapter({ command: process.execPath,
    argsPrefix: [fileURLToPath(new URL("./fixtures/codex-app-server.cjs", import.meta.url))], requestTimeoutMs: 100, startTimeoutMs: 500 });
  const events: WorkerEvent[] = [];
  const spawned: number[] = [];
  const start = async (signal?: AbortSignal): Promise<WorkerHandle> => {
    const handle = await adapter.start(spec, 1, child => { spawned.push(child.pid); }, signal);
    cleanup.push(() => handle.stop(100)); handle.onEvent(event => events.push(event)); return handle;
  };
  const messages = () => fs.existsSync(trace) ? fs.readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
  return { root, trace, spec, adapter, events, spawned, start, messages };
}

describe("worker environments", () => {
  test("a crashed daemon's stale process file cannot identify a new generation", () => {
    const { root } = fixture();
    const evidence = createProcessEvidence({ dataDir: root, workerId: "w1", generation: 1,
      harness: "codex", endpoint: "/tmp/owned.sock#w1@1", token: "old-token" });
    evidence.record({ pid: 123, processStartedAt: "old-start" });
    const env = { TT_SUPERVISOR_PROCESS_FILE: evidence.file,
      TT_SUPERVISOR_ENDPOINT: "/tmp/owned.sock#w1@1", TT_SUPERVISOR_TOKEN: "old-token" };
    expect(readProcessStartEvidence(env, "codex", 123)).toBe("old-start");
    expect(readProcessStartEvidence({ ...env, TT_SUPERVISOR_TOKEN: "new-token" }, "codex", 123)).toBeNull();
    expect(readProcessStartEvidence({ ...env, TT_SUPERVISOR_ENDPOINT: "/tmp/owned.sock#w1@2" }, "codex", 123)).toBeNull();
    expect(readProcessStartEvidence(env, "codex", 456)).toBeNull();
    if (process.platform !== "win32") {
      expect(fs.statSync(evidence.file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(evidence.file)).mode & 0o777).toBe(0o700);
    }
    evidence.clear(); expect(readProcessStartEvidence(env, "codex", 123)).toBeNull();
  });
  test.skipIf(process.platform === "win32")("resolves an official npm wrapper to its native binary and skips version-manager shims", () => {
    const { root } = fixture();
    const shim = path.join(root, "shims"), npm = path.join(root, "npm"), pkg = path.join(root, "package");
    fs.mkdirSync(shim); fs.mkdirSync(npm); fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
    fs.writeFileSync(path.join(root, "mise"), "shim"); fs.symlinkSync(path.join(root, "mise"), path.join(shim, "codex"));
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex" }));
    fs.writeFileSync(path.join(pkg, "bin/codex.js"), "#!/usr/bin/env node\n");
    fs.symlinkSync(path.join(pkg, "bin/codex.js"), path.join(npm, "codex"));
    const triple = process.platform === "darwin" ? `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`
      : `${process.arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-musl`;
    const native = path.join(pkg, "vendor", triple, "bin/codex");
    fs.mkdirSync(path.dirname(native), { recursive: true }); fs.writeFileSync(native, "native", { mode: 0o700 });
    expect(resolveCodexExecutable({ PATH: [shim, npm].join(path.delimiter) })).toBe(fs.realpathSync(native));
    fs.rmSync(native);
    expect(() => resolveCodexExecutable({ PATH: npm })).toThrow("CODEX_EXECUTABLE");
  });
  test("starts empty apart from required HOME/PATH, explicit refs, and protected runtime env", async () => {
    const f = fixture();
    f.spec.env.push({ name: "API_KEY", from: "inherit" }, { name: "TALKING_STICK_DATA_DIR", from: "literal", value: "wrong" });
    const env = await workerEnvironment(f.spec, { HOME: "/safe/home", PATH: "/safe/bin", API_KEY: "private", OTHER_SECRET: "absent", TT_ROOM: "wrong", CODEX_THREAD_ID: "wrong" });
    expect(env).toMatchObject({ HOME: "/safe/home", PATH: "/safe/bin", API_KEY: "private", TALKING_STICK_DATA_DIR: f.spec.supervisor_env!.TALKING_STICK_DATA_DIR });
    expect(env.OTHER_SECRET).toBeUndefined(); expect(env.TT_ROOM).toBeUndefined(); expect(env.CODEX_THREAD_ID).toBeUndefined();
    f.spec.env.push({ name: "CODEX_THREAD_ID", from: "inherit" });
    await expect(workerEnvironment(f.spec)).rejects.toThrow("identity marker");
  });
});

describe.skipIf(process.platform === "win32")("owned Codex app-server", () => {
  test("journals ownership before initialize, starts without a prompt, and pins permissions and data access", async () => {
    const f = fixture(); const h = await f.start();
    expect(f.spawned).toEqual([h.pid]); expect(h.pgid).toBe(h.pid);
    expect(f.messages().filter(m => m.method === "turn/start")).toHaveLength(0);
    const start = f.messages().find(m => m.method === "thread/start");
    expect(start.params).toMatchObject({ sandbox: "workspace-write", approvalPolicy: "on-request",
      config: { "sandbox_workspace_write.writable_roots": [f.spec.supervisor_env!.TALKING_STICK_DATA_DIR] } });
    expect(f.events).toContainEqual({ type: "session", session_id: "owned-thread" });
    expect(await h.probe()).toBe("alive");
    expect(fs.statSync(path.join(f.spec.supervisor_env!.TALKING_STICK_DATA_DIR, "supervisor/workers/w1/codex")).mode & 0o777).toBe(0o700);
  });
  test("idle input wakes again and a completion before the RPC reply stays complete", async () => {
    const f = fixture(); const h = await f.start();
    expect(await h.submit({ input_id: "a", text: "fast", mode: "start_turn" })).toBe("accepted");
    expect(f.events).toContainEqual({ type: "turn_completed", native_turn_id: "turn-1", outcome: "success" });
    expect(await h.submit({ input_id: "b", text: "second", mode: "start_turn" })).toBe("accepted");
    await until(() => f.events.some(e => e.type === "turn_completed" && e.native_turn_id === "turn-2"));
  });
  test("steers the exact active turn and confirms interruption from completion, never the RPC ack", async () => {
    const f = fixture(); const h = await f.start();
    await h.submit({ input_id: "a", text: "busy", mode: "start_turn" });
    expect(await h.submit({ input_id: "b", text: "steer", mode: "steer" })).toBe("accepted");
    expect(f.messages().find(m => m.method === "turn/steer").params.expectedTurnId).toBe("turn-1");
    expect(await h.interrupt()).toBe("interrupted"); expect(await h.interrupt()).toBe("not_busy");
    const uncertain = fixture("unconfirmed-interrupt"); const other = await uncertain.start();
    await other.submit({ input_id: "a", text: "busy", mode: "start_turn" });
    expect(await other.interrupt()).toBe("unsupported");
  });
  test("preserves request id zero, clears cancelled approvals and never grants session-wide permissions", async () => {
    const f = fixture(); const h = await f.start();
    await h.submit({ input_id: "a", text: "approval", mode: "start_turn" });
    await until(() => f.events.some(e => e.type === "approval_requested"));
    const request = f.events.find(e => e.type === "approval_requested") as Extract<WorkerEvent, { type: "approval_requested" }>;
    expect(request.native_request_id).toBe("n:0");
    await h.answerApproval(request.native_request_id, "deny");
    await until(() => f.events.some(e => e.type === "approval_resolved"));
    expect(f.messages().find(m => m.id === 0)).toEqual({ id: 0, result: { decision: "cancel" } });
    await expect(h.answerApproval(request.native_request_id, "allow")).rejects.toThrow("no longer pending");
  });
  test("a completed steer links its journal input before reasserting the already known completion", async () => {
    const f = fixture(); const h = await f.start();
    await h.submit({ input_id: "a", text: "busy", mode: "start_turn" });
    expect(await h.submit({ input_id: "b", text: "finish-before-reply", mode: "steer" })).toBe("accepted");
    expect(f.events.slice(-2)).toEqual([
      { type: "input", input_id: "b", outcome: "accepted", native_turn_id: "turn-1" },
      { type: "turn_completed", native_turn_id: "turn-1", outcome: "success" }
    ]);
    expect(await h.submit({ input_id: "c", text: "next", mode: "start_turn" })).toBe("accepted");
  });
  test("an unacknowledged write stays uncertain and is never queued or repeated", async () => {
    const f = fixture("no-reply"); const h = await f.start();
    expect(await h.submit({ input_id: "a", text: "unknown", mode: "start_turn" })).toBe("uncertain");
    expect(f.messages().filter(m => m.method === "turn/start")).toHaveLength(1);
  });
  test.each(["malformed", "overflow", "unsafe"])("refuses %s and stops the owned child before rejecting", async mode => {
    const f = fixture(mode); await expect(f.start()).rejects.toThrow();
    expect(f.spawned).toHaveLength(1);
    expect(createSystemProcessInspector().inspect(f.spawned[0])).toBeNull();
  });
  test("abort stops a child waiting in handshake", async () => {
    const f = fixture("hang-init"); const abort = new AbortController(); const pending = f.start(abort.signal);
    await until(() => f.spawned.length === 1); abort.abort();
    await expect(pending).rejects.toThrow(); expect(createSystemProcessInspector().inspect(f.spawned[0])).toBeNull();
  });
  test("resumes the exact owned session, refuses missing history, and drains stderr", async () => {
    const f = fixture("stderr"); f.spec.resume_session_id = "native-old"; const h = await f.start();
    expect(h.sessionId()).toBe("native-old"); expect(f.messages().some(m => m.method === "thread/start")).toBe(false);
    const missing = fixture(); missing.spec.resume_session_id = "missing";
    await expect(missing.start()).rejects.toThrow();
    expect(missing.messages().filter(m => m.method === "thread/start")).toHaveLength(0);
  });
  test("reports missing auth without a model turn", async () => {
    const f = fixture("no-auth"); await f.start();
    expect(f.events).toContainEqual({ type: "state", state: "auth_required" });
    expect(f.messages().some(m => m.method === "turn/start")).toBe(false);
  });
  test("stops the owned process group even when a child outlives its leader", async () => {
    const f = fixture("grandchild"); const h = await f.start();
    const pid = f.messages().find(m => m.grandchild)?.grandchild;
    expect(typeof pid).toBe("number");
    await h.stop(100);
    expect(createSystemProcessInspector().inspect(pid)).toBeNull();
  });
});
