import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import type { WorkerEvent, WorkerHandle, WorkerSpec } from "../src/supervisor/adapter.js";
import { builtinAdapters } from "../src/supervisor/adapters/index.js";
import { GrokAdapter, resolveGrokExecutable } from "../src/supervisor/adapters/grok.js";
import { createSystemProcessInspector } from "../src/process-utils.js";
import { Supervisor } from "../src/supervisor/daemon.js";
import { SupervisorStore, supervisorDatabasePath } from "../src/supervisor/state.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("Protocol fixture did not settle.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fixture(mode = "") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-adapter-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const trace = path.join(root, "trace.jsonl");
  const dataDir = path.join(root, "data");
  const spec: WorkerSpec = { worker_id: "w1", harness: "grok", cwd: root, permissions: { harness: "grok" },
    env: [{ name: "FIXTURE_MODE", from: "literal", value: mode }, { name: "FIXTURE_TRACE", from: "literal", value: trace }],
    supervisor_env: { TALKING_STICK_DATA_DIR: dataDir } };
  const adapter = new GrokAdapter({ command: process.execPath,
    argsPrefix: [fileURLToPath(new URL("./fixtures/grok-stdio.cjs", import.meta.url))], startTimeoutMs: 500 });
  const events: WorkerEvent[] = [];
  const spawned: number[] = [];
  const start = async (signal?: AbortSignal): Promise<WorkerHandle> => {
    const handle = await adapter.start(spec, 1, (child) => { spawned.push(child.pid); }, signal);
    cleanup.push(() => handle.stop(100));
    handle.onEvent((event) => events.push(event));
    return handle;
  };
  const lines = () => fs.existsSync(trace) ? fs.readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>) : [];
  const privateHome = path.join(dataDir, "supervisor", "workers", spec.worker_id, "grok");
  return { root, dataDir, trace, spec, adapter, events, spawned, start, lines, privateHome };
}

describe("Grok capabilities", () => {
  test("all four stay false, and the built-in registry includes the adapter", () => {
    const adapter = new GrokAdapter();
    expect(adapter.capabilities()).toEqual({ prompt: false, resume: false, interrupt: false, approvals: false });
    expect(builtinAdapters().grok?.capabilities()).toEqual(adapter.capabilities());
    expect(builtinAdapters().grok?.harness).toBe("grok");
  });

  test("an executable is resolved to an absolute real path", () => {
    expect(() => resolveGrokExecutable({ GROK_EXECUTABLE: "grok" })).toThrow("absolute");
    expect(resolveGrokExecutable({ GROK_EXECUTABLE: process.execPath })).toBe(fs.realpathSync(process.execPath));
    expect(() => resolveGrokExecutable({ PATH: "" })).toThrow("GROK_EXECUTABLE");
  });
});

describe("starting a Grok worker", () => {
  test("runs agent --no-leader stdio in a private home and never copies user config", async () => {
    process.env.TT_ROOM = "/somewhere/else";
    process.env.GROK_AGENT = "1";
    process.env.GROK_SESSION_ID = "live-session";
    process.env.TT_SUPERVISOR_TOKEN = "should-not-leak";
    cleanup.push(() => {
      delete process.env.TT_ROOM;
      delete process.env.GROK_AGENT;
      delete process.env.GROK_SESSION_ID;
      delete process.env.TT_SUPERVISOR_TOKEN;
    });
    const f = fixture();
    const userHome = path.join(f.root, "user-grok");
    fs.mkdirSync(userHome, { mode: 0o700 });
    fs.writeFileSync(path.join(userHome, "config.toml"), 'permission_mode = "always-approve"\n');
    fs.writeFileSync(path.join(userHome, "auth.json"), '{"secret":true}\n', { mode: 0o600 });
    f.spec.model = "grok-4";
    f.spec.env.push({ name: "GROK_HOME", from: "literal", value: userHome });
    const handle = await f.start();
    const startup = f.lines()[0];
    expect(startup.argv).toEqual(["agent", "--no-leader", "stdio"]);
    expect(startup.argv.join(" ")).not.toMatch(/always-approve|plugin-dir|--debug/);
    expect(startup.env).toMatchObject({
      TT_ROOM: null, GROK_AGENT: null, GROK_SESSION_ID: null,
      TT_SUPERVISOR_ENDPOINT: null, TT_SUPERVISOR_TOKEN: null,
      TALKING_STICK_DATA_DIR: f.dataDir, GROK_HOME: f.privateHome,
    });
    expect(startup.homeFiles).toEqual([]);
    expect(startup.configCopied).toBe(false);
    expect(fs.readdirSync(f.privateHome)).toEqual([]);
    expect(fs.readFileSync(path.join(userHome, "config.toml"), "utf8")).toContain("always-approve");
    expect(fs.statSync(f.privateHome).mode & 0o777).toBe(0o700);
    expect(fs.existsSync(path.join(f.dataDir, "supervisor", "workers", "w1", "process-1.json"))).toBe(false);
    expect(handle.sessionId()).toBe("grok-session-1");
    expect(f.events).toContainEqual({ type: "session", session_id: "grok-session-1" });
    expect(f.events.some((event) => event.type === "turn_started" || event.type === "turn_completed")).toBe(false);
    const initialize = f.lines().find((line) => line.method === "initialize");
    expect(initialize?.params).toEqual({ protocolVersion: 1, clientInfo: { name: "talking_stick_supervisor", version: "0" } });
    expect(initialize?.params?.clientCapabilities).toBeUndefined();
    const created = f.lines().find((line) => line.method === "session/new");
    expect(created?.params).toEqual({ cwd: f.spec.cwd, mcpServers: [] });
    expect(f.lines().some((line) => line.method === "session/prompt" || line.method === "session/resume" || line.method === "session/load")).toBe(false);
  });

  test("a resume id or the wrong permissions are rejected before spawn", async () => {
    const resumed = fixture();
    resumed.spec.resume_session_id = "live-session";
    await expect(resumed.start()).rejects.toThrow(/resume/);
    expect(resumed.spawned).toEqual([]);
    expect(fs.existsSync(resumed.trace)).toBe(false);
    const wrong = fixture();
    wrong.spec.permissions = { harness: "claude", mode: "default" };
    await expect(wrong.start()).rejects.toThrow(/permissions/);
    expect(wrong.spawned).toEqual([]);
  });

  test("an identity marker in the spec is rejected before spawn", async () => {
    const f = fixture();
    f.spec.env.push({ name: "GROK_AGENT", from: "literal", value: "1" });
    await expect(f.start()).rejects.toThrow(/identity marker/);
    expect(f.spawned).toEqual([]);
  });

  test.each(["auth", "no-session", "malformed"] as const)("a %s handshake stops the child", async (mode) => {
    const f = fixture(mode);
    await expect(f.start()).rejects.toThrow();
    expect(f.spawned).toHaveLength(1);
    expect(createSystemProcessInspector().inspect(f.spawned[0])).toBeNull();
  });

  test("abort stops a child waiting in handshake", async () => {
    const f = fixture("hang-init");
    const abort = new AbortController();
    const pending = f.start(abort.signal);
    await until(() => f.spawned.length === 1);
    abort.abort();
    await expect(pending).rejects.toThrow();
    expect(createSystemProcessInspector().inspect(f.spawned[0])).toBeNull();
  });
});

describe("a running Grok worker", () => {
  test("probe lists sessions, and submit, interrupt and approval send nothing", async () => {
    const f = fixture();
    const handle = await f.start();
    expect(await handle.probe()).toBe("alive");
    expect(f.lines().some((line) => line.method === "session/list")).toBe(true);
    const before = f.lines().length;
    expect(await handle.submit({ input_id: "i1", text: "hello", mode: "start_turn" })).toBe("rejected");
    expect(await handle.submit({ input_id: "i2", text: "steer", mode: "steer" })).toBe("rejected");
    expect(await handle.interrupt()).toBe("unsupported");
    await expect(handle.answerApproval("req-1", "allow")).rejects.toThrow(/not available/);
    expect(f.lines()).toHaveLength(before);
    expect(f.events.some((event) => event.type === "state" && event.state === "awaiting_input")).toBe(false);
  });

  test("a server request is refused without waiting for input", async () => {
    const f = fixture("server-request");
    const handle = await f.start();
    await until(() => f.events.some((event) => event.type === "request_refused"));
    expect(f.events).toContainEqual({ type: "request_refused", method: "fs/readTextFile" });
    await until(() => f.lines().some((line) => line.error?.code === -32601));
    expect(f.lines().find((line) => line.error)?.id).toBe(900);
    expect(f.events.some((event) => event.type === "state")).toBe(false);
    expect(createSystemProcessInspector().inspect(handle.pid)).not.toBeNull();
  });

  test("a malformed line after start is an overflow and stops the child", async () => {
    const f = fixture();
    const handle = await f.start();
    (handle as unknown as { receive(line: string): void }).receive("not-json");
    expect(f.events).toContainEqual({ type: "overflow" });
    await until(() => createSystemProcessInspector().inspect(handle.pid) == null);
  });
});

describe("supervisor restarts", () => {
  test("a configured resume is held before any process", async () => {
    const f = fixture();
    const store = new SupervisorStore(supervisorDatabasePath(f.dataDir));
    cleanup.push(() => store.close());
    const { supervisor_env: _ignored, ...stored } = f.spec;
    store.addWorker({ ...stored, resume_session_id: "already-open" }, "human:test", "t");
    const supervisor = new Supervisor({ store, adapters: { grok: f.adapter }, dataDir: f.dataDir, processLiveness: () => "gone" });
    cleanup.push(() => supervisor.shutdown());
    supervisor.reconcileStartup();
    await supervisor.tick();
    expect(store.worker("w1")?.hold_reason).toBe("resume_failed");
    expect(store.latestGeneration("w1")).toBeNull();
    expect(fs.existsSync(f.trace)).toBe(false);
  });

  test("a later tick after a recorded session holds resume_failed and does not spawn again", async () => {
    const f = fixture();
    const store = new SupervisorStore(supervisorDatabasePath(f.dataDir));
    cleanup.push(() => store.close());
    const { supervisor_env: _ignored, ...stored } = f.spec;
    store.addWorker(stored, "human:test", "t");
    let now = Date.parse("2026-10-26T00:00:00.000Z");
    const supervisor = new Supervisor({ store, adapters: { grok: f.adapter }, dataDir: f.dataDir,
      processLiveness: () => "gone", now: () => new Date(now) });
    cleanup.push(() => supervisor.shutdown());
    supervisor.reconcileStartup();
    await supervisor.tick();
    const generation = store.latestGeneration("w1");
    expect(generation?.session_id).toBe("grok-session-1");
    expect(generation?.delivery_token_hash).toBeNull();
    expect(supervisor.acceptIntake({ type: "deliver", worker_id: "w1", generation: 1, token: "not-issued",
      batch_token: "b1", text: "hello" })).toEqual({ outcome: "failed", error: "bad_token" });
    expect(f.lines().some((line) => line.method === "session/prompt")).toBe(false);
    const handle = supervisor.handle("w1");
    expect(handle).toBeTruthy();
    await handle!.stop(100);
    await until(() => store.latestGeneration("w1")?.state === "dead");
    const next = store.worker("w1")?.next_start_at;
    expect(next).toBeTruthy();
    now = Date.parse(next!) + 1;
    await supervisor.tick();
    expect(store.worker("w1")?.hold_reason).toBe("resume_failed");
    expect(f.lines().filter((line) => Array.isArray(line.argv))).toHaveLength(1);
    expect(f.lines().some((line) => line.method === "session/prompt" || line.method === "session/resume")).toBe(false);
  });

  test("an explicit fresh restart starts a new conversation", async () => {
    const f = fixture();
    const store = new SupervisorStore(supervisorDatabasePath(f.dataDir));
    cleanup.push(() => store.close());
    const { supervisor_env: _ignored, ...stored } = f.spec;
    store.addWorker(stored, "human:test", "t");
    let now = Date.parse("2026-10-26T00:00:00.000Z");
    const supervisor = new Supervisor({ store, adapters: { grok: f.adapter }, dataDir: f.dataDir,
      processLiveness: () => "gone", now: () => new Date(now) });
    cleanup.push(() => supervisor.shutdown());
    supervisor.reconcileStartup();
    await supervisor.tick();
    await supervisor.handle("w1")!.stop(100);
    await until(() => Boolean(store.worker("w1")?.next_start_at));
    now = Date.parse(store.worker("w1")!.next_start_at!) + 1;
    await supervisor.tick();
    expect(store.worker("w1")?.hold_reason).toBe("resume_failed");
    store.requestRestart("w1", true, "human:test", "t2");
    await supervisor.tick();
    expect(store.worker("w1")?.hold_reason).toBeNull();
    expect(store.latestGeneration("w1")?.session_id).toBe("grok-session-1");
    expect(f.lines().filter((line) => Array.isArray(line.argv))).toHaveLength(2);
    expect(f.lines().filter((line) => line.method === "session/new")).toHaveLength(2);
    expect(f.lines().some((line) => line.method === "session/resume" || line.method === "session/prompt")).toBe(false);
  });
});
