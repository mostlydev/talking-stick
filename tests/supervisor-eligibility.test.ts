import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { packageLinkTargets, packageRoot, pathsConflict, supervisorProgramPaths, workerIneligibility } from "../src/supervisor/eligibility.js";
import { CodexAdapter, effectiveConfinement } from "../src/supervisor/adapters/codex.js";
import type { WorkerHandle, WorkerSpec } from "../src/supervisor/adapter.js";
import { Supervisor } from "../src/supervisor/daemon.js";
import { SupervisorStore, supervisorDatabasePath } from "../src/supervisor/state.js";
import { localAuthenticationGate, type GateResult, type HumanGate } from "../src/supervisor/human-gate.js";
import { FakeAdapter } from "./fixtures/supervisor-fake.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

function tmp(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tt-elig-")));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("when a writable root reaches a protected path", () => {
  test("it conflicts when it is the path, holds it, or lies inside it, never when beside it", () => {
    const root = tmp();
    const guarded = path.join(root, "state", "root");
    expect(pathsConflict(guarded, guarded)).toBe(true);
    expect(pathsConflict(path.join(root, "state"), guarded)).toBe(true);
    expect(pathsConflict(root, guarded)).toBe(true);
    expect(pathsConflict(path.join(guarded, "workers"), guarded)).toBe(true);
    expect(pathsConflict(path.join(root, "state", "rooted"), guarded)).toBe(false);
    expect(pathsConflict(path.join(root, "work"), guarded)).toBe(false);
  });

  test("aliases and paths that don't exist yet are compared by their canonical form", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "real"));
    fs.symlinkSync(path.join(root, "real"), path.join(root, "alias"));
    expect(pathsConflict(path.join(root, "alias"), path.join(root, "real", "not", "yet"))).toBe(true);
  });
});

describe("Codex's effective confinement, from the policy it returned", () => {
  test("workspace-write covers the cwd, each root, and the temp directories it doesn't exclude", () => {
    expect(effectiveConfinement({ type: "workspaceWrite", writableRoots: ["/data"] }, "/work", "/var/tmp/x"))
      .toEqual({ kind: "workspace_write", writable: ["/work", "/data", "/tmp", "/var/tmp/x"] });
    expect(effectiveConfinement({ type: "workspaceWrite", writableRoots: [], excludeSlashTmp: true, excludeTmpdirEnvVar: true }, "/work", "/var/tmp/x"))
      .toEqual({ kind: "workspace_write", writable: ["/work"] });
    expect(effectiveConfinement({ type: "readOnly" }, "/work", null)).toEqual({ kind: "read_only" });
  });

  test("any other or incompletely described policy is unconfined", () => {
    for (const sandbox of [{ type: "dangerFullAccess" }, { type: "externalSandbox" }, {}, { type: "workspaceWrite", writableRoots: ["relative"] },
      { type: "workspaceWrite", writableRoots: "/data" }]) {
      expect(effectiveConfinement(sandbox, "/work", null).kind).toBe("unconfined");
    }
    expect(effectiveConfinement({ type: "workspaceWrite" }, "relative", null).kind).toBe("unconfined");
  });

  test("a started worker reports what Codex returned, and its executable and prepared home as its closure", async () => {
    const root = tmp();
    const spec: WorkerSpec = { worker_id: "w1", harness: "codex", cwd: root,
      permissions: { harness: "codex", sandbox: "workspace-write", approval: "on-request" },
      env: [{ name: "CODEX_HOME", from: "literal", value: path.join(root, "prepared") }],
      supervisor_env: { TALKING_STICK_DATA_DIR: path.join(root, "data") }, state_dir: path.join(root, "state") };
    const adapter = new CodexAdapter({ command: process.execPath,
      argsPrefix: [fileURLToPath(new URL("./fixtures/codex-app-server.cjs", import.meta.url))], requestTimeoutMs: 100, startTimeoutMs: 500 });
    const handle = await adapter.start(spec, 1, () => {});
    cleanup.push(() => handle.stop(100));
    expect(handle.confinement!()).toEqual({ kind: "workspace_write", writable: [root, path.join(root, "data"), "/tmp"] });
    expect(handle.executionClosure!().paths).toEqual(expect.arrayContaining([process.execPath, path.join(root, "prepared")]));
  });
});

describe("a worker's ineligibility", () => {
  const handle = (confinement: ReturnType<NonNullable<WorkerHandle["confinement"]>> | null,
    closure = { paths: [] as string[], unresolved: [] as string[] }) => ({
    ...(confinement ? { confinement: () => confinement } : {}), executionClosure: () => closure }) as unknown as WorkerHandle;

  test("an unconfined worker, or one whose harness reports nothing, is ineligible", () => {
    expect(workerIneligibility("w1", handle({ kind: "unconfined", reason: "its sandbox is dangerFullAccess" }), { paths: [], unresolved: [] }))
      .toEqual(["w1 is not write-confined: its sandbox is dangerFullAccess."]);
    expect(workerIneligibility("w1", handle(null), { paths: [], unresolved: [] })[0]).toContain("reports no write confinement");
  });

  test("a writable root that reaches the state root, the program or the worker's own closure is ineligible", () => {
    const root = tmp();
    const guarded = { paths: [path.join(root, "state")], unresolved: [] };
    expect(workerIneligibility("w1", handle({ kind: "workspace_write", writable: [path.join(root, "work")] }), guarded)).toEqual([]);
    expect(workerIneligibility("w1", handle({ kind: "workspace_write", writable: [root] }), guarded)).toHaveLength(1);
    // The guarded set is the union of every worker's closure, a prepared home among them.
    const withHome = { paths: [...guarded.paths, path.join(root, "work", "codex-home")], unresolved: [] };
    expect(workerIneligibility("w1", handle({ kind: "workspace_write", writable: [path.join(root, "work")] }), withHome)[0])
      .toContain("codex-home");
  });

  test("a closure that couldn't be resolved is ineligible even read-only", () => {
    expect(workerIneligibility("w1", handle({ kind: "read_only" }, { paths: [], unresolved: ["its native executable"] }), { paths: [], unresolved: [] }))
      .toEqual(["w1: its native executable couldn't be resolved."]);
  });
});

describe("the supervisor's own program", () => {
  test("is the runtime and the package this module was loaded from, or the standalone root", () => {
    const program = supervisorProgramPaths();
    expect(program.unresolved).toEqual([]);
    expect(program.paths).toContain(fs.realpathSync(process.execPath));
    expect(program.paths).toContain(packageRoot(fileURLToPath(import.meta.url)));
    const root = tmp();
    expect(supervisorProgramPaths({ standaloneRoot: root }).paths).toContain(root);
    expect(supervisorProgramPaths({ execPath: path.join(root, "missing") }).unresolved).toEqual([`the runtime ${path.join(root, "missing")}`]);
  });
});

describe("the daemon with a gate in use", () => {
  const confirm: HumanGate = { kind: "scripted", confirm: async (): Promise<GateResult> => "confirmed" };
  async function setup(gate: HumanGate | undefined, protectedPath: string) {
    const dataDir = tmp();
    const store = new SupervisorStore(supervisorDatabasePath(dataDir));
    cleanup.push(() => store.close());
    const adapter = new FakeAdapter("claude");
    const supervisor = new Supervisor({ store, adapters: { claude: adapter }, processLiveness: () => "gone", stateDir: path.join(dataDir, "state"),
      ...(gate ? { gate } : {}), protectedSet: { paths: [protectedPath], unresolved: [] } });
    supervisor.reconcileStartup();
    store.addWorker({ worker_id: "w1", harness: "claude", cwd: dataDir, permissions: { harness: "claude", mode: "default" }, env: [] }, "human:op", "t");
    return { dataDir, store, adapter, supervisor };
  }

  test("holds and stops a worker that could reach a protected path, but only once a gate is in use", async () => {
    const protectedPath = path.join(tmp(), "program");
    for (const gate of [confirm, undefined]) {
      const { store, adapter, supervisor } = await setup(gate, protectedPath);
      adapter.nextConfinement = { kind: "workspace_write", writable: [path.dirname(protectedPath)] };
      await supervisor.tick();
      if (gate) {
        expect(store.worker("w1")!.hold_reason).toBe("gate_ineligible");
        expect(adapter.last.stopped).toBe(true);
        expect(store.auditRows("w1").find((row) => row.action === "gate_ineligible")?.detail).toContain(protectedPath);
      } else {
        expect(store.worker("w1")!.hold_reason).toBeNull();
      }
    }
  });

  test("refuses control without asking while any live worker is ineligible, and when one becomes so during the question", async () => {
    let release: (result: GateResult) => void = () => {};
    let asked = 0;
    const waiting: HumanGate = { kind: "scripted", confirm: () => { asked++; return new Promise((resolve) => { release = resolve; }); } };
    const protectedPath = path.join(tmp(), "program");
    const { adapter, supervisor } = await setup(waiting, protectedPath);
    await supervisor.tick();
    adapter.last.emit({ type: "turn_started", native_turn_id: "t1" });
    adapter.last.confined = { kind: "unconfined", reason: "its sandbox is dangerFullAccess" };
    expect(await supervisor.control({ action: "interrupt", actor: "human:op", worker_id: "w1" }))
      .toMatchObject({ ok: false, gate: "ineligible", error: expect.stringContaining("dangerFullAccess") });
    expect(asked).toBe(0);
    adapter.last.confined = { kind: "read_only" };
    const asking = supervisor.control({ action: "interrupt", actor: "human:op", worker_id: "w1" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    adapter.last.confined = { kind: "workspace_write", writable: [protectedPath] };
    release("confirmed");
    expect(await asking).toMatchObject({ ok: false, gate: "changed" });
    expect(adapter.last.interrupts).toEqual([]);
  });

  test("a worker whose resume widens its confinement, or fails, is stopped and held at once", async () => {
    const protectedPath = path.join(tmp(), "program");
    for (const change of ["confinement", "resume_failed"] as const) {
      const { store, adapter, supervisor } = await setup(confirm, protectedPath);
      await supervisor.tick();
      const handle = adapter.last;
      expect(store.worker("w1")!.hold_reason).toBeNull();
      if (change === "confinement") {
        handle.confined = { kind: "workspace_write", writable: [path.dirname(protectedPath)] };
        handle.emit({ type: "confinement" });
      } else {
        // A failed open leaves the adapter unconfined, never its previous report.
        handle.confined = { kind: "unconfined", reason: "Codex has not reported the sandbox of its latest thread open" };
        handle.emit({ type: "resume_failed" });
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(handle.stopped).toBe(true);
      expect(store.worker("w1")!.hold_reason).toBe("gate_ineligible");
      expect(store.auditRows("w1").some((row) => row.action === "gate_ineligible")).toBe(true);
    }
  });

  test("Codex reports a resume's sandbox, and an open that fails leaves it unconfined", async () => {
    const root = tmp();
    const spec: WorkerSpec = { worker_id: "w1", harness: "codex", cwd: root,
      permissions: { harness: "codex", sandbox: "read-only", approval: "on-request" },
      env: [{ name: "FIXTURE_MODE", from: "literal", value: "unload-fail" }],
      supervisor_env: { TALKING_STICK_DATA_DIR: path.join(root, "data") }, state_dir: path.join(root, "state") };
    const adapter = new CodexAdapter({ command: process.execPath,
      argsPrefix: [fileURLToPath(new URL("./fixtures/codex-app-server.cjs", import.meta.url))], requestTimeoutMs: 100, startTimeoutMs: 500 });
    const handle = await adapter.start(spec, 1, () => {});
    cleanup.push(() => handle.stop(100));
    const events: string[] = [];
    handle.onEvent((event) => events.push(event.type));
    expect(handle.confinement!()).toEqual({ kind: "read_only" });
    // The fixture unloads the thread and then refuses to resume it.
    (handle as unknown as { receive(line: string): void }).receive(JSON.stringify({ method: "thread/status/changed",
      params: { threadId: handle.sessionId(), status: { type: "notLoaded" } } }));
    await handle.probe();
    expect(events).toContain("resume_failed");
    expect(handle.confinement!().kind).toBe("unconfined");
    expect(events).toContain("confinement");
  });

  test("with no protected set, no gate acts at all", async () => {
    const dataDir = tmp();
    const store = new SupervisorStore(supervisorDatabasePath(dataDir));
    cleanup.push(() => store.close());
    const adapter = new FakeAdapter("claude");
    const supervisor = new Supervisor({ store, adapters: { claude: adapter }, processLiveness: () => "gone", gate: confirm });
    supervisor.reconcileStartup();
    store.addWorker({ worker_id: "w1", harness: "claude", cwd: dataDir, permissions: { harness: "claude", mode: "default" }, env: [] }, "human:op", "t");
    await supervisor.tick();
    expect(store.worker("w1")!.hold_reason).toBe("gate_ineligible");
  });
});

// Codex's review of #219 (#32880), kept verbatim.
test("review: a dot-dot-prefixed child is still inside its writable parent", () => {
  const root = tmp();
  expect(pathsConflict(root, path.join(root, "..supervisor", "control"))).toBe(true);
});

test("review: the worker can replace a lexical symlink even when its target is protected", () => {
  const root = tmp(), work = path.join(root, "work"), guarded = path.join(root, "guarded");
  fs.mkdirSync(work); fs.mkdirSync(guarded);
  const home = path.join(work, "prepared-home"); fs.symlinkSync(guarded, home);
  expect(pathsConflict(work, home)).toBe(true);
});

test("review: one worker must not rewrite another worker's execution closure", async () => {
  const root = tmp(); const shared = path.join(root, "shared-startup");
  const store = new SupervisorStore(supervisorDatabasePath(root)); cleanup.push(() => store.close());
  const adapter = new FakeAdapter("claude");
  const supervisor = new Supervisor({ store, adapters: { claude: adapter }, processLiveness: () => "gone",
    stateDir: path.join(root, "state"), gate: { kind: "scripted", confirm: async () => "confirmed" },
    protectedSet: { paths: [path.join(root, "program")], unresolved: [] } });
  supervisor.reconcileStartup();
  for (const id of ["writer", "victim"]) store.addWorker({ worker_id: id, harness: "claude", cwd: root,
    permissions: { harness: "claude", mode: "default" }, env: [] }, "human:op", "t");
  await supervisor.tick();
  adapter.handles[0].confined = { kind: "workspace_write", writable: [shared] };
  adapter.handles[1].closure = { paths: [path.join(shared, "native-executable")], unresolved: [] };
  expect(supervisor.gateIneligibility().length).toBeGreaterThan(0);
});

describe("closures beyond one worker", () => {
  test("a worker isn't started while a live worker can write what it would run; the writer is held when found", async () => {
    const root = tmp();
    const shared = path.join(root, "shared");
    const store = new SupervisorStore(supervisorDatabasePath(root)); cleanup.push(() => store.close());
    const adapter = new FakeAdapter("claude");
    const supervisor = new Supervisor({ store, adapters: { claude: adapter }, processLiveness: () => "gone",
      stateDir: path.join(root, "state"), gate: { kind: "scripted", confirm: async () => "confirmed" },
      protectedSet: { paths: [path.join(root, "program")], unresolved: [] } });
    supervisor.reconcileStartup();
    adapter.nextConfinement = { kind: "workspace_write", writable: [shared] };
    store.addWorker({ worker_id: "writer", harness: "claude", cwd: root, permissions: { harness: "claude", mode: "default" }, env: [] }, "human:op", "t");
    await supervisor.tick();
    expect(store.worker("writer")!.hold_reason).toBeNull();
    // A second worker whose executable sits where the first can write: it never spawns.
    adapter.startClosures.victim = { paths: [path.join(shared, "codex")], unresolved: [] };
    const spawned = adapter.handles.length;
    store.addWorker({ worker_id: "victim", harness: "claude", cwd: root, permissions: { harness: "claude", mode: "default" }, env: [] }, "human:op", "t");
    await supervisor.tick();
    expect(adapter.handles).toHaveLength(spawned);
    expect(store.worker("victim")!.hold_reason).toBe("gate_ineligible");
  });

  test("the gate's own helper is protected", async () => {
    const root = tmp();
    const helper = path.join(root, "work", "tt-human-gate");
    const store = new SupervisorStore(supervisorDatabasePath(root)); cleanup.push(() => store.close());
    const adapter = new FakeAdapter("claude");
    adapter.nextConfinement = { kind: "workspace_write", writable: [path.join(root, "work")] };
    const supervisor = new Supervisor({ store, adapters: { claude: adapter }, processLiveness: () => "gone", stateDir: path.join(root, "state"),
      gate: { kind: "helper", protectedPaths: [helper], confirm: async () => "confirmed" }, protectedSet: { paths: [], unresolved: [] } });
    supervisor.reconcileStartup();
    store.addWorker({ worker_id: "w1", harness: "claude", cwd: root, permissions: { harness: "claude", mode: "default" }, env: [] }, "human:op", "t");
    await supervisor.tick();
    expect(store.worker("w1")!.hold_reason).toBe("gate_ineligible");
    expect(localAuthenticationGateProtects(helper)).toBe(true);
  });

  test("a dependency linked out of the package is protected where it points", () => {
    const root = tmp();
    const pkg = path.join(root, "pkg"), outside = path.join(root, "outside", "dep");
    fs.mkdirSync(path.join(pkg, "node_modules"), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), "{}");
    fs.symlinkSync(outside, path.join(pkg, "node_modules", "dep"));
    const links = packageLinkTargets(pkg);
    expect(links.unresolved).toEqual([]);
    expect(links.paths).toEqual(expect.arrayContaining([path.join(pkg, "node_modules", "dep"), outside]));
    expect(links.paths.some((guarded) => pathsConflict(path.join(root, "outside"), guarded))).toBe(true);
  });
});

function localAuthenticationGateProtects(helper: string): boolean {
  return (localAuthenticationGate({ helper }).protectedPaths ?? []).includes(helper);
}

test.skipIf(process.platform === "win32")("review: a worker-writable human-gate helper is ineligible", async () => {
  const root = tmp(), work = path.join(root, "work"); fs.mkdirSync(work);
  const helper = path.join(work, "gate-helper");
  // A disposable stand-in for a helper the worker could replace with exit 0.
  fs.writeFileSync(helper, `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o700 });
  const store = new SupervisorStore(supervisorDatabasePath(root)); cleanup.push(() => store.close());
  const adapter = new FakeAdapter("claude");
  const supervisor = new Supervisor({ store, adapters: { claude: adapter }, processLiveness: () => "gone",
    stateDir: path.join(root, "state"), gate: localAuthenticationGate({ helper }),
    protectedSet: { paths: [path.join(root, "program")], unresolved: [] } });
  supervisor.reconcileStartup();
  store.addWorker({ worker_id: "w1", harness: "claude", cwd: work,
    permissions: { harness: "claude", mode: "default" }, env: [] }, "human:op", "t");
  await supervisor.tick();
  adapter.last.confined = { kind: "workspace_write", writable: [work] };
  adapter.last.emit({ type: "turn_started", native_turn_id: "t1" });
  expect(await supervisor.control({ action: "interrupt", actor: "claude:w1", worker_id: "w1" }))
    .toMatchObject({ ok: false, gate: "ineligible" });
  expect(adapter.last.interrupts).toEqual([]);
});

test("an eligible Codex worker survives an idle reload with a gate in use, and the resume is sent", async () => {
  const root = tmp();
  const store = new SupervisorStore(supervisorDatabasePath(root)); cleanup.push(() => store.close());
  const trace = path.join(root, "trace.jsonl");
  const adapter = new CodexAdapter({ command: process.execPath,
    argsPrefix: [fileURLToPath(new URL("./fixtures/codex-app-server.cjs", import.meta.url))], requestTimeoutMs: 200, startTimeoutMs: 1_000 });
  const supervisor = new Supervisor({ store, adapters: { codex: adapter }, processLiveness: () => "alive", stateDir: path.join(root, "state"),
    dataDir: path.join(root, "data"), gate: { kind: "scripted", confirm: async () => "confirmed" },
    protectedSet: { paths: [path.join(root, "program")], unresolved: [] } });
  cleanup.push(() => supervisor.shutdown());
  supervisor.reconcileStartup();
  store.addWorker({ worker_id: "w1", harness: "codex", cwd: path.join(root, "work"),
    permissions: { harness: "codex", sandbox: "read-only", approval: "on-request" },
    env: [{ name: "FIXTURE_TRACE", from: "literal", value: trace }] }, "human:op", "t");
  fs.mkdirSync(path.join(root, "work"));
  await supervisor.tick();
  expect(store.worker("w1")!.hold_reason).toBeNull();
  const handle = supervisor.handle("w1")!;
  (handle as unknown as { receive(line: string): void }).receive(JSON.stringify({ method: "thread/status/changed",
    params: { threadId: handle.sessionId(), status: { type: "notLoaded" } } }));
  expect(await handle.probe()).toBe("alive");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const sent = fs.readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line)).map((message) => message.method);
  expect(sent.filter((method) => method === "thread/resume")).toHaveLength(1);
  expect(store.worker("w1")!.hold_reason).toBeNull();
  expect(store.auditRows("w1").some((row) => row.action === "gate_ineligible")).toBe(false);
});
