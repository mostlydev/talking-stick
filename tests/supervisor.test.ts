import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SupervisorStore, supervisorDatabasePath } from "../src/supervisor/state.js";
import { Supervisor, acquireOwnerLock, CRASH_LIMIT } from "../src/supervisor/daemon.js";
import type { WorkerSpec } from "../src/supervisor/adapter.js";
import { FakeAdapter } from "./fixtures/supervisor-fake.js";
import type { RoomBridge } from "../src/supervisor/room-bridge.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

const bootstrapBridge: RoomBridge = { fence() {}, recover: () => ({ recovered: [], refused: [] }),
  sessionStarted() {}, lostSessions: () => [] };

function setup(options: { liveness?: (pid: number) => "alive" | "gone" | "unknown" } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-supervisor-"));
  let clock = new Date("2026-10-26T09:00:00.000Z");
  const open = () => {
    const store = new SupervisorStore(supervisorDatabasePath(dataDir));
    cleanup.push(() => store.close());
    return store;
  };
  const store = open();
  const adapter = new FakeAdapter("claude");
  let ids = 0;
  const make = (s = store, a = adapter, extra: { codex?: FakeAdapter; tickWaitMs?: number } = {}) => new Supervisor({
    store: s, adapters: { claude: a, ...(extra.codex ? { codex: extra.codex } : {}) },
    processLiveness: (pid) => options.liveness?.(pid) ?? "gone", now: () => clock, newId: () => `input-${++ids}`,
    ...(extra.tickWaitMs ? { tickWaitMs: extra.tickWaitMs } : {}) });
  const supervisor = make();
  supervisor.reconcileStartup();
  cleanup.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const spec: WorkerSpec = { worker_id: "w1", harness: "claude", cwd: dataDir,
    permissions: { harness: "claude", mode: "default" }, env: [{ name: "PATH", from: "inherit" }] };
  const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };
  return { dataDir, store, adapter, supervisor, spec, advance, open, make };
}

describe("the supervisor's store", () => {
  test("is private to the user and keeps env references, not values", () => {
    const { dataDir, store, spec } = setup();
    store.addWorker({ ...spec, env: [{ name: "API_KEY", from: "keychain", service: "tt-worker" }] }, "human:op", "t");
    if (process.platform !== "win32") expect(fs.statSync(supervisorDatabasePath(dataDir)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(store.worker("w1")!.spec_json).env).toEqual([{ name: "API_KEY", from: "keychain", service: "tt-worker" }]);
  });
});

describe("one-time room enrolment", () => {
  test("bootstraps one native session once, including across a process restart", async () => {
    const { store, adapter, spec } = setup();
    store.addWorker({ ...spec, resume_session_id: "native-first" }, "human:op", "t");
    const supervisor = new Supervisor({ store, adapters: { claude: adapter }, processLiveness: () => "gone",
      bridge: bootstrapBridge, socketPath: "/tmp/bootstrap.sock", bootstrap: true });
    supervisor.reconcileStartup();
    await supervisor.tick();
    expect(adapter.last.submitted).toHaveLength(1);
    expect(adapter.last.submitted[0].text).toContain("tt join --json");
    expect(store.db.prepare("SELECT source FROM inputs").all()).toEqual([{ source: "bootstrap" }]);
    await supervisor.tick(); expect(adapter.last.submitted).toHaveLength(1);
    adapter.last.emit({ type: "turn_started", native_turn_id: "bootstrap-turn", input_id: adapter.last.submitted[0].input_id });
    adapter.last.emit({ type: "turn_completed", native_turn_id: "bootstrap-turn", outcome: "success" });
    adapter.last.emit({ type: "exited", code: 1, signal: null });
    // Restart after the backoff (the supervisor's clock is real in this test).
    store.setNextStart("w1", null);
    await supervisor.tick();
    expect(adapter.handles).toHaveLength(2);
    expect(adapter.last.submitted).toHaveLength(0);
    expect(store.db.prepare("SELECT * FROM bootstrap_sessions").all()).toHaveLength(1);
  });
  test("an enrolment reserved before a daemon crash is held, never silently replayed", async () => {
    const { store, adapter, supervisor, spec } = setup();
    store.addWorker({ ...spec, resume_session_id: "native-first" }, "human:op", "t");
    await supervisor.tick();
    expect(store.claimBootstrap("w1", "native-first", "bootstrap-1", 1, "t")).toBe(true);
    expect(store.claimBootstrap("w1", "native-first", "bootstrap-2", 1, "t")).toBe(false);
    expect(store.input("bootstrap-2")).toBeNull();
    adapter.last.emit({ type: "exited", code: 1, signal: null });
    const recovered = new Supervisor({ store, adapters: { claude: adapter }, processLiveness: () => "gone",
      bridge: bootstrapBridge, socketPath: "/tmp/bootstrap.sock", bootstrap: true });
    recovered.reconcileStartup();
    expect(store.worker("w1")?.hold_reason).toBe("bootstrap_failed");
    await recovered.tick(); expect(adapter.handles).toHaveLength(1);
  });
  test("does not bootstrap a worker blocked on authentication", async () => {
    const { store, adapter, spec } = setup();
    const start = adapter.start.bind(adapter);
    adapter.start = async (...args) => {
      const handle = await start(...args);
      const listen = handle.onEvent.bind(handle);
      handle.onEvent = listener => { listen(listener); listener({ type: "state", state: "auth_required" }); };
      return handle;
    };
    store.addWorker({ ...spec, resume_session_id: "native-first" }, "human:op", "t");
    const supervisor = new Supervisor({ store, adapters: { claude: adapter }, processLiveness: () => "gone",
      bridge: bootstrapBridge, socketPath: "/tmp/bootstrap.sock", bootstrap: true });
    supervisor.reconcileStartup(); await supervisor.tick();
    expect(adapter.last.submitted).toEqual([]);
    expect(store.db.prepare("SELECT * FROM bootstrap_sessions").all()).toEqual([]);
    adapter.last.emit({ type: "state", state: "idle" });
    await supervisor.tick();
    expect(adapter.last.submitted).toHaveLength(1);
  });
  test.each(["error", "interrupted", "process_exit"] as const)("holds an enrolment that ends with %s instead of replaying it", async outcome => {
    const { store, adapter, spec } = setup();
    store.addWorker({ ...spec, resume_session_id: "native-first" }, "human:op", "t");
    const supervisor = new Supervisor({ store, adapters: { claude: adapter }, processLiveness: () => "gone",
      bridge: bootstrapBridge, socketPath: "/tmp/bootstrap.sock", bootstrap: true });
    supervisor.reconcileStartup(); await supervisor.tick();
    const input = adapter.last.submitted[0];
    adapter.last.emit({ type: "turn_started", native_turn_id: "enrol", input_id: input.input_id });
    if (outcome === "process_exit") adapter.last.emit({ type: "exited", code: 1, signal: null });
    else adapter.last.emit({ type: "turn_completed", native_turn_id: "enrol", outcome });
    expect(store.worker("w1")?.hold_reason).toBe("bootstrap_failed");
    await supervisor.tick();
    expect(adapter.handles).toHaveLength(1);
    expect(adapter.last.submitted).toHaveLength(1);
    if (outcome !== "process_exit") adapter.last.emit({ type: "exited", code: 0, signal: null });
    const restored = new Supervisor({ store, adapters: { claude: adapter }, processLiveness: () => "gone" });
    restored.reconcileStartup();
    expect(store.worker("w1")?.hold_reason).toBe("bootstrap_failed");
  });
});

describe("starting and restarting workers", () => {
  test("starts a running worker once and records its exact process before any input", async () => {
    const { store, adapter, supervisor, spec } = setup();
    store.addWorker(spec, "human:op", "t");
    await supervisor.tick();
    await supervisor.tick();
    expect(adapter.handles).toHaveLength(1);
    expect(store.latestGeneration("w1")).toMatchObject({ generation: 1, pid: 1000, process_started_at: "start-1000", pgid: 1000, state: "idle" });
    expect(adapter.last.submitted).toEqual([]);
  });

  test("a crash restarts with backoff, resumes the session, and five in the window hold it", async () => {
    const { store, adapter, supervisor, spec, advance } = setup();
    store.addWorker(spec, "human:op", "t");
    await supervisor.tick();
    adapter.last.emit({ type: "session", session_id: "native-1" });
    adapter.last.emit({ type: "exited", code: 1, signal: null });
    await supervisor.tick();
    expect(adapter.handles).toHaveLength(1);
    advance(5_001);
    await supervisor.tick();
    expect(adapter.handles).toHaveLength(2);
    expect(adapter.last.spec.resume_session_id).toBe("native-1");
    for (let crash = 2; crash <= CRASH_LIMIT; crash++) {
      adapter.last.liveness = "gone";
      await supervisor.tick();
      advance(60_000);
      await supervisor.tick();
    }
    expect(store.worker("w1")!.hold_reason).toBe("crash_loop");
    const started = adapter.handles.length;
    advance(60 * 60_000);
    await supervisor.tick();
    expect(adapter.handles).toHaveLength(started);
  });

  test("a session the adapter cannot resume is held instead of quietly restarted fresh", async () => {
    const { store, adapter, supervisor, spec, advance } = setup();
    store.addWorker(spec, "human:op", "t");
    await supervisor.tick();
    adapter.last.emit({ type: "session", session_id: "native-1" });
    adapter.caps = { ...adapter.caps, resume: false };
    adapter.last.emit({ type: "exited", code: 1, signal: null });
    advance(10_000);
    await supervisor.tick();
    expect(store.worker("w1")!.hold_reason).toBe("resume_failed");
    expect(adapter.handles).toHaveLength(1);
    store.requestRestart("w1", true, "human:op", "t2");
    await supervisor.tick();
    expect(adapter.handles).toHaveLength(2);
    expect(adapter.last.spec.resume_session_id).toBeUndefined();
  });

  test("a failed resume is held, not retried as a new conversation", async () => {
    const { store, adapter, supervisor, spec } = setup();
    store.addWorker({ ...spec, resume_session_id: "native-9" }, "human:op", "t");
    adapter.failStart = (started) => started.resume_session_id === "native-9";
    await supervisor.tick();
    expect(store.worker("w1")!.hold_reason).toBe("resume_failed");
  });
});

describe("control fencing", () => {
  test("a pause during a slow start wins: the started process is stopped, not kept", async () => {
    const { store, adapter, supervisor, spec } = setup();
    store.addWorker(spec, "human:op", "t");
    let release!: () => void;
    adapter.holdStart = new Promise((resolve) => { release = resolve; });
    const ticking = supervisor.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.setDesired("w1", "paused", "human:op", "t1");
    release();
    await ticking;
    expect(adapter.last.stopped).toBe(true);
    expect(supervisor.handle("w1")).toBeUndefined();
    expect(store.crashesSince("w1", "2000-01-01")).toBe(0);
  });

  test("stop always wins and is not a crash", async () => {
    const { store, adapter, supervisor, spec } = setup();
    store.addWorker(spec, "human:op", "t");
    await supervisor.tick();
    store.setDesired("w1", "stopped", "human:op", "t1");
    await supervisor.tick();
    expect(adapter.last.stopped).toBe(true);
    expect(store.crashesSince("w1", "2000-01-01")).toBe(0);
    expect(store.auditRows("w1").map((row) => row.action)).toEqual(["add", "start", "stop", "exit"]);
  });
});

describe("daemon restart", () => {
  test("a prior generation that may still be alive holds the worker; a gone one ends", async () => {
    const alive = setup({ liveness: () => "alive" });
    alive.store.addWorker(alive.spec, "human:op", "t");
    await alive.supervisor.tick();
    const restarted = alive.make(alive.store, new FakeAdapter("claude"));
    restarted.reconcileStartup();
    await restarted.tick();
    expect(alive.store.worker("w1")!.hold_reason).toBe("prior_generation_alive");
    expect(alive.store.liveGenerations()).toHaveLength(1);

    const unknown = setup({ liveness: () => "unknown" });
    unknown.store.addWorker(unknown.spec, "human:op", "t");
    await unknown.supervisor.tick();
    unknown.make(unknown.store, new FakeAdapter("claude")).reconcileStartup();
    expect(unknown.store.worker("w1")!.hold_reason).toBe("prior_generation_unknown");

    const gone = setup({ liveness: () => "gone" });
    gone.store.addWorker(gone.spec, "human:op", "t");
    await gone.supervisor.tick();
    const fresh = new FakeAdapter("claude");
    const next = gone.make(gone.store, fresh);
    next.reconcileStartup();
    await next.tick();
    expect(gone.store.liveGenerations().map((row) => row.generation)).toEqual([2]);
    expect(fresh.handles).toHaveLength(1);
  });

  test("only one supervisor owns a data directory", () => {
    const { dataDir } = setup();
    const lock = path.join(dataDir, "supervisor.lock");
    let ownerAlive: "alive" | "gone" = "alive";
    const release = acquireOwnerLock(lock, { pid: 1, process_started_at: "a" }, () => ownerAlive);
    expect(() => acquireOwnerLock(lock, { pid: 2, process_started_at: "b" }, () => ownerAlive)).toThrow("Another supervisor");
    ownerAlive = "gone";
    const second = acquireOwnerLock(lock, { pid: 2, process_started_at: "b" }, () => ownerAlive);
    release();
    expect(fs.existsSync(lock)).toBe(true);
    second();
    expect(fs.existsSync(lock)).toBe(false);
  });
});

describe("inputs", () => {
  test("an input is journalled before it is written, and a crash leaves written inputs uncertain", async () => {
    const { store, adapter, supervisor, spec } = setup();
    store.addWorker(spec, "human:op", "t");
    await supervisor.tick();
    let journalled: string | undefined;
    adapter.last.submitOutcome = async () => {
      journalled = store.input("input-1")?.state;
      return "written";
    };
    const sent = await supervisor.submit("w1", "hello", "start_turn", "test");
    // Journalled, then marked dispatching, before the adapter writes anything.
    expect(journalled).toBe("dispatching");
    expect(sent).toEqual({ input_id: "input-1", outcome: "written" });
    adapter.last.emit({ type: "exited", code: null, signal: "SIGKILL" });
    expect(store.input("input-1")!.state).toBe("uncertain");
    // An uncertain input never moves again, and is never resubmitted.
    store.updateInput("input-1", "w1", 1, "accepted", "t9");
    expect(store.input("input-1")!.state).toBe("uncertain");
  });

  test("accepted inputs complete with their turn, and a write that throws is uncertain", async () => {
    const { store, adapter, supervisor, spec } = setup();
    store.addWorker(spec, "human:op", "t");
    await supervisor.tick();
    adapter.last.submitOutcome = "written";
    await supervisor.submit("w1", "go", "start_turn", "test");
    adapter.last.emit({ type: "turn_started", native_turn_id: "turn-1", input_id: "input-1" });
    expect(store.latestGeneration("w1")).toMatchObject({ state: "busy" });
    adapter.last.emit({ type: "turn_completed", native_turn_id: "turn-1", outcome: "success" });
    expect(store.input("input-1")).toMatchObject({ state: "completed", native_turn_id: "turn-1", turn_outcome: "success" });
    adapter.last.submitOutcome = async () => { throw new Error("pipe broke"); };
    expect((await supervisor.submit("w1", "again", "start_turn", "test")).outcome).toBe("uncertain");
  });

  test("a worker whose adapter cannot take a prompt refuses input", async () => {
    const { store, adapter, supervisor, spec } = setup();
    adapter.caps = { prompt: false, resume: false, interrupt: false, approvals: false };
    store.addWorker(spec, "human:op", "t");
    await supervisor.tick();
    await expect(supervisor.submit("w1", "hi", "start_turn", "test")).rejects.toThrow("cannot take a prompt");
    expect(store.input("input-1")).toBeNull();
  });
});

describe("approvals", () => {
  test("are keyed by request: a native id in a new generation, or reused after settling, is a new request", async () => {
    const { store, adapter, supervisor, spec, advance } = setup();
    store.addWorker(spec, "human:op", "t");
    await supervisor.tick();
    const first = adapter.last;
    first.emit({ type: "approval_requested", native_request_id: "0", tool: "Bash", summary: "touch x" });
    expect(store.latestGeneration("w1")!.state).toBe("awaiting_approval");
    const firstRequest = store.pendingApproval("w1", 1, "0")!;
    first.emit({ type: "exited", code: 1, signal: null });
    expect(store.approval(firstRequest.approval_id)!.status).toBe("expired");
    advance(10_000);
    await supervisor.tick();
    const second = adapter.last;
    second.emit({ type: "approval_requested", native_request_id: "0", tool: "Bash", summary: "rm y" });
    const secondRequest = store.pendingApproval("w1", 2, "0")!;
    await expect(supervisor.decideApproval({ approval_id: firstRequest.approval_id, worker_id: "w1", generation: 1 }, "allow", "human:op"))
      .rejects.toThrow("is not running");
    await expect(supervisor.decideApproval({ approval_id: firstRequest.approval_id, worker_id: "w1", generation: 2 }, "allow", "human:op"))
      .rejects.toThrow("is not running");
    expect(await supervisor.decideApproval({ approval_id: secondRequest.approval_id, worker_id: "w1", generation: 2 }, "deny", "human:op"))
      .toBe("delivered");
    expect(second.answers).toEqual([{ id: "0", decision: "deny" }]);
    expect(first.answers).toEqual([]);
    await expect(supervisor.decideApproval({ approval_id: secondRequest.approval_id, worker_id: "w1", generation: 2 }, "allow", "human:op"))
      .rejects.toThrow("not pending");
    // Events from the dead generation never reach the live one.
    first.emit({ type: "approval_requested", native_request_id: "7", tool: "Bash", summary: "late" });
    expect(store.pendingApproval("w1", 1, "7")).toBeNull();
  });

  test("a stale decision cannot approve a native id reused in the same generation", async () => {
    const { store, adapter, supervisor, spec } = setup();
    store.addWorker(spec, "human:op", "t");
    await supervisor.tick();
    adapter.last.emit({ type: "approval_requested", native_request_id: "0", tool: "read", summary: "first" });
    const oldKey = { approval_id: store.pendingApproval("w1", 1, "0")!.approval_id, worker_id: "w1", generation: 1 };
    await supervisor.decideApproval(oldKey, "deny", "human:op");
    adapter.last.emit({ type: "approval_requested", native_request_id: "0", tool: "write", summary: "different request" });
    await expect(supervisor.decideApproval(oldKey, "allow", "human:op")).rejects.toThrow();
    expect(adapter.last.answers).toEqual([{ id: "0", decision: "deny" }]);
  });

  test("a second request under a still-pending id holds the worker", async () => {
    const { store, adapter, supervisor, spec } = setup();
    store.addWorker(spec, "human:op", "t");
    await supervisor.tick();
    adapter.last.emit({ type: "approval_requested", native_request_id: "0", tool: "read", summary: "first" });
    adapter.last.emit({ type: "approval_requested", native_request_id: "0", tool: "write", summary: "second" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.worker("w1")!.hold_reason).toBe("protocol_error");
    expect(adapter.last.stopped).toBe(true);
  });

  test("a decision stays made when delivering its answer fails", async () => {
    const { store, adapter, supervisor, spec } = setup();
    store.addWorker(spec, "human:op", "t");
    await supervisor.tick();
    adapter.last.emit({ type: "approval_requested", native_request_id: "a1", tool: "Bash", summary: "x" });
    adapter.last.answerApproval = async () => { throw new Error("EPIPE"); };
    const request = store.pendingApproval("w1", 1, "a1")!;
    expect(await supervisor.decideApproval({ approval_id: request.approval_id, worker_id: "w1", generation: 1 }, "allow", "human:op"))
      .toBe("failed");
    expect(store.approval(request.approval_id)).toMatchObject({ status: "allowed", answer_status: "failed" });
  });

  test("expire after 24 hours as a deny", async () => {
    const { store, adapter, supervisor, spec, advance } = setup();
    store.addWorker(spec, "human:op", "t");
    await supervisor.tick();
    adapter.last.emit({ type: "approval_requested", native_request_id: "a1", tool: "Bash", summary: "x" });
    const request = store.pendingApproval("w1", 1, "a1")!;
    advance(24 * 60 * 60_000 + 1);
    await supervisor.tick();
    expect(store.approval(request.approval_id)).toMatchObject({ status: "expired", decided_by: "supervisor", answer_status: "delivered" });
    expect(adapter.last.answers).toEqual([{ id: "a1", decision: "deny" }]);
  });
});

test("a request the harness settles itself expires, and a later decision is refused", async () => {
  const { store, adapter, supervisor, spec } = setup();
  store.addWorker(spec, "human:op", "t");
  await supervisor.tick();
  adapter.last.emit({ type: "turn_started", native_turn_id: "t1" });
  adapter.last.emit({ type: "approval_requested", native_request_id: "0", tool: "Bash", summary: "x" });
  const request = store.pendingApproval("w1", 1, "0")!;
  adapter.last.emit({ type: "approval_resolved", native_request_id: "0" });
  expect(store.approval(request.approval_id)).toMatchObject({ status: "expired", decided_by: "harness" });
  expect(store.latestGeneration("w1")!.state).toBe("busy");
  await expect(supervisor.decideApproval({ approval_id: request.approval_id, worker_id: "w1", generation: 1 }, "allow", "human:op"))
    .rejects.toThrow("not pending");
  expect(adapter.last.answers).toEqual([]);
});

test("shutdown cancels a start still in its handshake, so no child outlives the daemon", async () => {
  const { store, adapter, spec, make } = setup();
  store.addWorker(spec, "human:op", "t");
  const supervisor = make(store, adapter, { tickWaitMs: 1 });
  supervisor.reconcileStartup();
  let release!: () => void;
  adapter.holdStart = new Promise((resolve) => { release = resolve; });
  await supervisor.tick();
  await supervisor.shutdown();
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(adapter.last.stopped).toBe(true);
  expect(supervisor.handle("w1")).toBeUndefined();
  expect(store.liveGenerations()).toEqual([]);
  expect(store.crashesSince("w1", "2000-01-01")).toBe(0);
});

describe("ownership through a crash", () => {
  test("a supervisor crash during the handshake leaves an owned child that holds, not a duplicate", async () => {
    const { store, adapter, supervisor, spec, make } = setup({ liveness: () => "alive" });
    store.addWorker(spec, "human:op", "t");
    adapter.holdStart = new Promise(() => {});
    void supervisor.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.latestGeneration("w1")).toMatchObject({ generation: 1, pid: 1000, state: "starting" });
    const fresh = new FakeAdapter("claude");
    const restarted = make(store, fresh);
    restarted.reconcileStartup();
    await restarted.tick();
    expect(store.worker("w1")!.hold_reason).toBe("prior_generation_alive");
    expect(fresh.handles).toHaveLength(0);
  });

  test("a start intent with no recorded child holds as unknown", async () => {
    const { store, spec, make } = setup();
    store.addWorker(spec, "human:op", "t");
    store.recordGeneration({ worker_id: "w1", generation: 1, pid: null, process_started_at: null, pgid: null,
      session_id: null, state: "starting", started_at: "t" });
    const fresh = new FakeAdapter("claude");
    const restarted = make(store, fresh);
    restarted.reconcileStartup();
    await restarted.tick();
    expect(store.worker("w1")!.hold_reason).toBe("prior_generation_unknown");
    expect(fresh.handles).toHaveLength(0);
  });

  test("the first tick refuses to run before startup reconciliation", async () => {
    const { make } = setup();
    await expect(make().tick()).rejects.toThrow("Reconcile recorded generations");
  });

  test("a hung handshake does not freeze other workers", async () => {
    const { store, spec, make } = setup();
    const codex = new FakeAdapter("codex");
    codex.holdStart = new Promise(() => {});
    const supervisor = make(store, undefined, { codex, tickWaitMs: 20 });
    supervisor.reconcileStartup();
    store.addWorker({ ...spec, worker_id: "hung", harness: "codex", permissions: { harness: "codex", sandbox: "read-only", approval: "on-request" } }, "human:op", "t");
    store.addWorker(spec, "human:op", "t");
    await supervisor.tick();
    expect(supervisor.handle("w1")).toBeDefined();
    store.setDesired("w1", "stopped", "human:op", "t1");
    await supervisor.tick();
    expect(supervisor.handle("w1")).toBeUndefined();
  });
});

describe("resuming across failed attempts", () => {
  test("a retry after a failed resume still resumes the original conversation", async () => {
    const { store, adapter, supervisor, spec, advance } = setup();
    store.addWorker(spec, "human:op", "t");
    await supervisor.tick();
    adapter.last.emit({ type: "session", session_id: "native-original" });
    adapter.last.emit({ type: "exited", code: 1, signal: null });
    advance(10_000);
    adapter.failStart = (started) => started.resume_session_id === "native-original";
    await supervisor.tick();
    expect(store.worker("w1")!.hold_reason).toBe("resume_failed");
    adapter.failStart = null;
    store.setDesired("w1", "running", "human:op", "t2", true);
    await supervisor.tick();
    expect(adapter.last.spec.resume_session_id).toBe("native-original");
  });

  test("a fresh restart stays fresh across a failed attempt, then resumes what it started", async () => {
    const { store, adapter, supervisor, spec, advance } = setup();
    store.addWorker(spec, "human:op", "t");
    await supervisor.tick();
    adapter.last.emit({ type: "session", session_id: "native-original" });
    store.requestRestart("w1", true, "human:op", "t1");
    adapter.failStart = () => true;
    await supervisor.tick();
    await supervisor.tick();
    expect(adapter.handles).toHaveLength(1);
    adapter.failStart = null;
    advance(10_000);
    await supervisor.tick();
    expect(adapter.handles).toHaveLength(2);
    expect(adapter.last.spec.resume_session_id).toBeUndefined();
    adapter.last.emit({ type: "session", session_id: "native-new" });
    adapter.last.emit({ type: "exited", code: 1, signal: null });
    advance(10_000);
    await supervisor.tick();
    expect(adapter.last.spec.resume_session_id).toBe("native-new");
  });
});

test("a configured seed session never overrides a later fresh conversation", async () => {
  const { store, adapter, supervisor, spec, advance } = setup();
  store.addWorker({ ...spec, resume_session_id: "native-seed" }, "human:op", "t");
  await supervisor.tick();
  expect(adapter.last.spec.resume_session_id).toBe("native-seed");
  store.requestRestart("w1", true, "human:op", "t2");
  await supervisor.tick();
  await supervisor.tick();
  expect(adapter.last.spec.resume_session_id).toBeUndefined();
  adapter.last.emit({ type: "session", session_id: "native-fresh" });
  adapter.last.emit({ type: "exited", code: 1, signal: null });
  advance(10_000);
  await supervisor.tick();
  expect(adapter.last.spec.resume_session_id).toBe("native-fresh");
});

describe("restart and status", () => {
  test("a restart stops the running generation and resumes its session; a fresh one starts anew", async () => {
    const { store, adapter, supervisor, spec } = setup();
    store.addWorker(spec, "human:op", "t");
    await supervisor.tick();
    adapter.last.emit({ type: "session", session_id: "native-1" });
    store.requestRestart("w1", false, "human:op", "t1");
    await supervisor.tick();
    expect(adapter.handles[0].stopped).toBe(true);
    await supervisor.tick();
    expect(adapter.handles).toHaveLength(2);
    expect(adapter.last.spec.resume_session_id).toBe("native-1");
    store.requestRestart("w1", true, "human:op", "t2");
    await supervisor.tick();
    await supervisor.tick();
    expect(adapter.handles).toHaveLength(3);
    expect(adapter.last.spec.resume_session_id).toBeUndefined();
    expect(store.crashesSince("w1", "2000-01-01")).toBe(0);
  });

  test("an unknown probe is shown as unknown, and the reported state comes back once it reads alive", async () => {
    const { store, adapter, supervisor, spec } = setup();
    store.addWorker(spec, "human:op", "t");
    await supervisor.tick();
    adapter.last.emit({ type: "turn_started", native_turn_id: "t1" });
    adapter.last.liveness = "unknown";
    await supervisor.tick();
    expect(store.latestGeneration("w1")!.state).toBe("unknown");
    adapter.last.liveness = "alive";
    await supervisor.tick();
    expect(store.latestGeneration("w1")!.state).toBe("busy");
  });
});

test.each(["overflow", "protocol_error"] as const)("a worker's %s holds the worker and stops it", async (type) => {
  const { store, adapter, supervisor, spec } = setup();
  store.addWorker(spec, "human:op", "t");
  await supervisor.tick();
  adapter.last.emit({ type });
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(store.worker("w1")!.hold_reason).toBe(type);
  expect(adapter.last.stopped).toBe(true);
});

// Codex's adversarial review of #203 (#32324).
describe("review regressions", () => {
  test("a pause fences input before the next tick stops the handle", async () => {
    const { store, supervisor, spec, adapter } = setup();
    store.addWorker(spec, "human:op", "t");
    await supervisor.tick();
    store.setDesired("w1", "paused", "human:op", "t1");
    await expect(supervisor.submit("w1", "must not run", "start_turn", "review")).rejects.toThrow("is not running");
    expect(adapter.last.submitted).toEqual([]);
  });

  test("a turn that completes before submit resolves stays completed, with its outcome", async () => {
    const { store, supervisor, spec, adapter } = setup();
    store.addWorker(spec, "human:op", "t");
    await supervisor.tick();
    const handle = adapter.last;
    handle.submit = async (input) => {
      handle.emit({ type: "turn_started", native_turn_id: "turn-probe", input_id: input.input_id });
      handle.emit({ type: "input", input_id: input.input_id, outcome: "written" });
      handle.emit({ type: "turn_completed", native_turn_id: "turn-probe", outcome: "interrupted" });
      return "accepted";
    };
    const sent = await supervisor.submit("w1", "tiny answer", "start_turn", "review");
    expect(store.input(sent.input_id)).toMatchObject({ state: "completed", turn_outcome: "interrupted" });
  });

  test("an exit during the write, before any written event, is uncertain, not rejected", async () => {
    const { store, supervisor, spec, adapter } = setup();
    store.addWorker(spec, "human:op", "t");
    await supervisor.tick();
    const handle = adapter.last;
    handle.submit = async () => {
      handle.emit({ type: "exited", code: 1, signal: null });
      return "uncertain";
    };
    const sent = await supervisor.submit("w1", "may have run", "start_turn", "review");
    expect(store.input(sent.input_id)!.state).toBe("uncertain");
  });

  test("an input event from another generation never moves this one's input", async () => {
    const { store, supervisor, spec, adapter } = setup();
    store.addWorker(spec, "human:op", "t");
    await supervisor.tick();
    adapter.last.submitOutcome = "written";
    await supervisor.submit("w1", "x", "start_turn", "review");
    store.updateInput("input-1", "w1", 2, "accepted", "t");
    expect(store.input("input-1")!.state).toBe("written");
  });

  test.each([1, 2])("concurrent stale-lock reapers never both take ownership (contender at read %i)", (at) => {
    const { dataDir } = setup();
    const lock = path.join(dataDir, "owner.lock");
    fs.writeFileSync(lock, JSON.stringify({ pid: 100, process_started_at: "dead" }));
    const read = fs.readFileSync.bind(fs);
    let reads = 0;
    let nested = false;
    let releaseA: (() => void) | undefined;
    let releaseB: (() => void) | undefined;
    const live = (pid: number) => pid === 100 ? "gone" as const : "alive" as const;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((file: unknown, ...args: unknown[]) => {
      const value = (read as (...a: unknown[]) => unknown)(file, ...args);
      if (file === lock && !nested && ++reads === at) {
        nested = true;
        try { releaseB = acquireOwnerLock(lock, { pid: 200, process_started_at: "b" }, live); } catch { /* loses */ }
      }
      return value;
    }) as typeof fs.readFileSync);
    try {
      try { releaseA = acquireOwnerLock(lock, { pid: 300, process_started_at: "a" }, live); } catch { /* loses */ }
      expect(Boolean(releaseA) && Boolean(releaseB)).toBe(false);
    } finally {
      spy.mockRestore();
      releaseA?.();
      releaseB?.();
    }
  });

  test("a stop that throws is audited and never crashes the loop", async () => {
    const { store, supervisor, spec, adapter } = setup();
    store.addWorker(spec, "human:op", "t");
    await supervisor.tick();
    adapter.last.stop = async () => { throw new Error("EPIPE"); };
    store.setDesired("w1", "stopped", "human:op", "t1");
    await supervisor.tick();
    expect(store.auditRows("w1").map((row) => row.action)).toContain("stop_failed");
    expect(supervisor.handle("w1")).toBeDefined();
  });
});
