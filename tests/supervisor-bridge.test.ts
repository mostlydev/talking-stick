import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  TalkingStickCommands,
  TalkingStickService,
  createSystemNativeWakeTransport,
  resolveCliSessionPath,
  writeCliSessions,
  type ProcessMetadata
} from "../src/index.js";
import { SupervisorStore, supervisorDatabasePath } from "../src/supervisor/state.js";
import { Supervisor } from "../src/supervisor/daemon.js";
import { startIntakeServer } from "../src/supervisor/intake.js";
import { createRoomBridge } from "../src/supervisor/room-bridge.js";
import type { WorkerSpec } from "../src/supervisor/adapter.js";
import { FakeAdapter, type FakeHandle } from "./fixtures/supervisor-fake.js";

// End to end over the real room database, the supervisor's database and its
// intake socket: tt delivers to the supervisor, which fences, writes into a
// fake worker, and leaves the acknowledgement to the model's own tt ack.

const HOST = "host-b";
const OP = "human:op:chat:1";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function setup(options: { prompt?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-svb-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "package.json"), "{}\n");
  let clock = new Date("2026-10-26T09:00:00.000Z");
  const service = new TalkingStickService({ dataDir, hostId: HOST, processLivenessChecker: () => "alive",
    receiverLivenessChecker: () => "gone", nativeWakeTransport: createSystemNativeWakeTransport(),
    wakeTransport: { deliver() { return { delivered: false, definite_failure: true }; } } });
  cleanup.push(() => service.close());
  const store = new SupervisorStore(supervisorDatabasePath(dataDir));
  cleanup.push(() => store.close());
  const socketPath = path.join(dataDir, "sv", "c.sock");
  const adapter = new FakeAdapter("claude");
  if (options.prompt === false) adapter.caps = { prompt: false, resume: true, interrupt: false, approvals: false };
  let ids = 0;
  const supervisor = new Supervisor({ store, adapters: { claude: adapter }, processLiveness: () => "alive",
    now: () => clock, newId: () => `id-${++ids}`, bridge: createRoomBridge(service, { dataDir, hostId: HOST }), socketPath });
  const server = await startIntakeServer(socketPath, (message) => supervisor.acceptIntake(message));
  cleanup.push(() => server.close());
  supervisor.reconcileStartup();
  const roomId = service.joinPath({ agent_id: OP, context_path: project,
    process_metadata: { host_id: HOST, pid: 10, process_started_at: "t", session_kind: "human_chat", display_name: "op" } }).room_id;
  const spec: WorkerSpec = { worker_id: "w1", harness: "claude", cwd: project,
    permissions: { harness: "claude", mode: "default" }, env: [] };
  store.addWorker(spec, "human:op", "t");
  const commands = new TalkingStickCommands(service);
  const identity = (handle: FakeHandle) => {
    const meta: ProcessMetadata = { host_id: HOST, pid: handle.pid, process_started_at: handle.processStartedAt,
      session_kind: "harness_cli", display_name: "claude", harness_name: "claude", harness_session_id: "harness:native-1",
      harness_host_id: HOST, harness_pid: handle.pid, harness_process_started_at: handle.processStartedAt };
    return { agent_id: "claude:wk", process_metadata: meta };
  };
  /** What the worker's own tt join does: join, then register its endpoint from its environment. */
  const workerJoins = (handle: FakeHandle) => {
    const joined = service.joinPath({ agent_id: "claude:wk", context_path: project, process_metadata: identity(handle).process_metadata,
      recover: true });
    commands.registerNativeWakeEndpoints(identity(handle), { room_id: roomId, env: handle.spec.supervisor_env ?? {}, host_id: HOST });
    return joined;
  };
  const startWorker = async () => {
    await supervisor.tick();
    const handle = adapter.last;
    handle.emit({ type: "session", session_id: "native-1" });
    return handle;
  };
  const direct = async (body: string) => {
    const sent = await service.sendMessageAndWake({ agent_id: OP, room_id: roomId, to_agent_id: "claude:wk", body });
    await service.flushWakes();
    return sent.event_seq;
  };
  const batches = () => service.db.prepare("SELECT token, delivery_mode, acknowledged_at, event_seqs_json FROM native_delivery_batches")
    .all() as Array<{ token: string; delivery_mode: string | null; acknowledged_at: string | null; event_seqs_json: string }>;
  const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };
  return { service, store, supervisor, adapter, roomId, dataDir, project, workerJoins, startWorker, direct, batches, advance, identity };
}

describe("tt to a supervised worker", () => {
  test("a direct message is journalled, fenced, written, and acknowledged by the model's own tt ack", async () => {
    const { service, store, adapter, workerJoins, startWorker, direct, batches } = await setup();
    const handle = await startWorker();
    expect(handle.spec.supervisor_env?.TT_SUPERVISOR_ENDPOINT).toMatch(/#w1@1$/);
    workerJoins(handle);
    await direct("please review");
    await until(() => adapter.last.submitted.length === 1);
    const written = adapter.last.submitted[0];
    expect(written).toMatchObject({ mode: "start_turn" });
    expect(written.text).toContain("please review");
    const token = /tt ack (\S+)/.exec(written.text)![1];
    await until(() => batches()[0]?.delivery_mode === "managed_written");
    expect(store.input(written.input_id)).toMatchObject({ state: "accepted", source: "tt_envelope", batch_token: token });
    expect(service.acknowledgeNativeDelivery({ agent_id: "claude:wk", token, harness_session_id: "harness:native-1", host_id: HOST }).status)
      .toBe("acknowledged");
    handle.emit({ type: "turn_completed", native_turn_id: "t1", outcome: "success" });
  });

  test("peer room messages never reach the worker", async () => {
    const { service, roomId, project, adapter, workerJoins, startWorker, store } = await setup();
    const handle = await startWorker();
    workerJoins(handle);
    service.joinPath({ agent_id: "codex:peer", context_path: project });
    await service.sendMessageAndWake({ agent_id: "codex:peer", room_id: roomId, body: "agents chatting" });
    await service.flushWakes();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(adapter.last.submitted).toEqual([]);
    expect(store.db.prepare("SELECT * FROM inputs").all()).toEqual([]);
  });

  test("a prompt-false worker gets no supervisor endpoint", async () => {
    const { startWorker } = await setup({ prompt: false });
    const handle = await startWorker();
    expect(handle.spec.supervisor_env).toBeUndefined();
  });
});

describe("crashes", () => {
  test("between intake and write: nothing was written, and the next generation gets the message", async () => {
    const { service, store, adapter, workerJoins, startWorker, direct, batches, supervisor, advance } = await setup();
    const first = await startWorker();
    workerJoins(first);
    first.emit({ type: "turn_started", native_turn_id: "busy" });
    const seq = await direct("while busy");
    await until(() => store.db.prepare("SELECT 1 FROM inputs").get() !== undefined);
    expect(first.submitted).toEqual([]);
    first.emit({ type: "exited", code: 1, signal: null });
    expect((store.db.prepare("SELECT state FROM inputs").get() as { state: string }).state).toBe("rejected");
    expect(batches()[0].delivery_mode).toBeNull();
    advance(10_000);
    await supervisor.tick();
    const second = adapter.last;
    expect(second.generation).toBe(2);
    expect(second.spec.resume_session_id).toBe("native-1");
    workerJoins(second);
    await service.flushWakes();
    await until(() => second.submitted.length === 1);
    expect(second.submitted[0].text).toContain(`#${seq} `);
  });

  test("after the write: uncertain, fenced, and never offered to the next generation", async () => {
    const { service, store, adapter, workerJoins, startWorker, direct, batches, supervisor, advance } = await setup();
    const first = await startWorker();
    workerJoins(first);
    first.submitOutcome = "written";
    const seq = await direct("maybe ran");
    await until(() => batches()[0]?.delivery_mode === "managed_written");
    first.emit({ type: "exited", code: null, signal: "SIGKILL" });
    expect((store.db.prepare("SELECT state FROM inputs").get() as { state: string }).state).toBe("uncertain");
    advance(10_000);
    await supervisor.tick();
    const second = adapter.last;
    workerJoins(second);
    await service.flushWakes();
    const later = await direct("new work");
    await until(() => second.submitted.length === 1);
    expect(second.submitted[0].text).toContain(`#${later} `);
    expect(second.submitted[0].text).not.toContain(`#${seq} `);
    expect(batches().find((batch) => JSON.parse(batch.event_seqs_json).includes(seq))?.delivery_mode).toBe("managed_written");
  });
});

describe("recovery of an owned worker", () => {
  test("a lost membership is rejoined with the worker's own credential and endpoint, and a revoked one is left alone", async () => {
    const { service, store, supervisor, roomId, dataDir, project, workerJoins, startWorker } = await setup();
    const handle = await startWorker();
    const joined = workerJoins(handle);
    writeCliSessions(resolveCliSessionPath({ dataDir }), [{ agent_id: "claude:wk", room_id: roomId, canonical_path: project,
      workspace_root: project, recovery_credential: joined.recovery_credential, updated_at: "t" }]);
    service.recordSessionLifecycle({ harness: "claude", sessionId: "native-1", pid: handle.pid,
      processStartedAt: handle.processStartedAt, event: "SessionEnd" });
    expect(service.getRoomState({ room_id: roomId }).lost_members?.map((lost) => lost.agent_id)).toEqual(["claude:wk"]);
    await supervisor.tick();
    expect(service.getRoomState({ room_id: roomId }).members.map((member) => member.agent_id)).toContain("claude:wk");
    expect(service.db.prepare("SELECT transport FROM member_wake_endpoints WHERE agent_id = 'claude:wk'").all())
      .toEqual([{ transport: "supervisor" }]);
    expect(store.auditRows("w1").map((row) => row.action)).toContain("recovered_membership");
    // No lease, and nothing the model did.
    expect(service.getRoomState({ room_id: roomId }).room.owner).toBeNull();
    expect(store.latestGeneration("w1")!.last_model_activity_at).toBeNull();

    service.recordSessionLifecycle({ harness: "claude", sessionId: "native-1", pid: handle.pid,
      processStartedAt: handle.processStartedAt, event: "SessionEnd" });
    service.kickMember({ room_id: roomId, agent_id: OP, target_agent_id: "claude:wk", force: true });
    await supervisor.tick();
    await supervisor.tick();
    expect(service.getRoomState({ room_id: roomId }).members.map((member) => member.agent_id)).not.toContain("claude:wk");
  });
});

describe("the intake socket", () => {
  const request = async (socketPath: string, chunks: Buffer[]) => {
    const net = await import("node:net");
    return new Promise<string>((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let reply = "";
      socket.setEncoding("utf8");
      socket.on("data", (data: string) => { reply += data; });
      socket.on("end", () => resolve(reply.trim()));
      socket.on("error", reject);
      socket.on("connect", async () => {
        for (const chunk of chunks) {
          socket.write(chunk);
          await new Promise((done) => setTimeout(done, 5));
        }
      });
    });
  };
  const serve = async (accept: Parameters<typeof startIntakeServer>[1]) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-intake-"));
    const socketPath = path.join(dir, "c.sock");
    const server = await startIntakeServer(socketPath, accept);
    cleanup.push(async () => { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    return socketPath;
  };
  const valid = (text: string) => ({ type: "deliver", worker_id: "w1", generation: 1, token: "t", batch_token: "b", text });

  test("refuses null and malformed lines, and answers failed when accept throws synchronously", async () => {
    const socketPath = await serve(() => { throw new Error("boom"); });
    expect(JSON.parse(await request(socketPath, [Buffer.from("null\n")]))).toEqual({ outcome: "failed", error: "bad_request" });
    expect(JSON.parse(await request(socketPath, [Buffer.from("{nope\n")]))).toEqual({ outcome: "failed", error: "bad_request" });
    expect(JSON.parse(await request(socketPath, [Buffer.from(`${JSON.stringify(valid("x"))}\n`)])))
      .toEqual({ outcome: "failed", error: "internal" });
  });

  test("accepts one request per connection and keeps UTF-8 split across chunks", async () => {
    const seen: string[] = [];
    const socketPath = await serve((message) => { seen.push(message.text); return { outcome: "queued" }; });
    const line = Buffer.from(`${JSON.stringify(valid("界👩🏽‍💻 end"))}\n${JSON.stringify(valid("second"))}\n`);
    const split = line.indexOf(Buffer.from("界")) + 1;
    expect(JSON.parse(await request(socketPath, [line.subarray(0, split), line.subarray(split)]))).toEqual({ outcome: "queued" });
    expect(seen).toEqual(["界👩🏽‍💻 end"]);
  });
});

// Codex's review of #206 (#32469).
describe("drain state and resumed generations", () => {
  test("a turn that completes before submit resolves does not strand the next intake", async () => {
    const { service, workerJoins, startWorker, direct } = await setup();
    const handle = await startWorker();
    workerJoins(handle);
    handle.submit = async (input) => {
      handle.submitted.push(input);
      handle.emit({ type: "turn_started", input_id: input.input_id, native_turn_id: input.input_id });
      handle.emit({ type: "turn_completed", native_turn_id: input.input_id, outcome: "success" });
      return "accepted";
    };
    await direct("fast first");
    await until(() => handle.submitted.length === 1);
    const token = /tt ack (\S+)/.exec(handle.submitted[0].text)![1];
    service.acknowledgeNativeDelivery({ agent_id: "claude:wk", token, harness_session_id: "harness:native-1", host_id: HOST });
    await direct("fast second");
    await until(() => handle.submitted.length === 2, 1_000);
  });

  test.each(["approval", "disconnected", "auth_required", "unknown"] as const)("a worker in a %s state gets no new turn", async (wait) => {
    const { supervisor, workerJoins, startWorker, direct } = await setup();
    const handle = await startWorker();
    workerJoins(handle);
    if (wait === "approval") {
      handle.emit({ type: "turn_started", native_turn_id: "blocked" });
      handle.emit({ type: "approval_requested", native_request_id: "0", tool: "shell", summary: "wait for human" });
    } else if (wait === "unknown") {
      handle.liveness = "unknown";
      await supervisor.tick();
    } else {
      handle.emit({ type: "state", state: wait });
    }
    await direct("normal notification");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(handle.submitted).toHaveLength(0);
  });

  test("a resumed generation re-binds its membership and endpoint itself, with the session's credential", async () => {
    const { service, store, supervisor, adapter, roomId, dataDir, project, workerJoins, startWorker, advance } = await setup();
    const first = await startWorker();
    const joined = workerJoins(first);
    writeCliSessions(resolveCliSessionPath({ dataDir }), [{ agent_id: "claude:wk", room_id: roomId, canonical_path: project,
      workspace_root: project, recovery_credential: joined.recovery_credential, updated_at: "t" }]);
    first.emit({ type: "exited", code: 1, signal: null });
    advance(10_000);
    await supervisor.tick();
    await supervisor.tick();
    const second = adapter.last;
    expect(second.generation).toBe(2);
    const endpoint = service.db.prepare("SELECT address FROM member_wake_endpoints WHERE agent_id = 'claude:wk'").get() as { address: string };
    expect(endpoint.address).toMatch(/@2$/);
    expect(service.getRoomState({ room_id: roomId }).members.find((member) => member.agent_id === "claude:wk")?.harness_pid).toBe(second.pid);
    expect(service.getRoomState({ room_id: roomId }).room.owner).toBeNull();
    expect(store.auditRows("w1").map((row) => row.action)).toContain("recovered_membership");
  });

  test("a resumed generation recovers a membership lost before the crash, and not one the operator kicked", async () => {
    const { service, supervisor, adapter, roomId, dataDir, project, workerJoins, startWorker, advance } = await setup();
    const first = await startWorker();
    const joined = workerJoins(first);
    writeCliSessions(resolveCliSessionPath({ dataDir }), [{ agent_id: "claude:wk", room_id: roomId, canonical_path: project,
      workspace_root: project, recovery_credential: joined.recovery_credential, updated_at: "t" }]);
    service.recordSessionLifecycle({ harness: "claude", sessionId: "native-1", pid: first.pid,
      processStartedAt: first.processStartedAt, event: "SessionEnd" });
    first.emit({ type: "exited", code: 1, signal: null });
    advance(10_000);
    await supervisor.tick();
    await supervisor.tick();
    expect(service.getRoomState({ room_id: roomId }).members.map((member) => member.agent_id)).toContain("claude:wk");
    expect((service.db.prepare("SELECT address FROM member_wake_endpoints WHERE agent_id = 'claude:wk'").get() as { address: string }).address)
      .toMatch(/@2$/);

    service.recordSessionLifecycle({ harness: "claude", sessionId: "native-1", pid: adapter.last.pid,
      processStartedAt: adapter.last.processStartedAt, event: "SessionEnd" });
    service.kickMember({ room_id: roomId, agent_id: OP, target_agent_id: "claude:wk", force: true });
    adapter.last.emit({ type: "exited", code: 1, signal: null });
    advance(10_000);
    await supervisor.tick();
    await supervisor.tick();
    expect(service.getRoomState({ room_id: roomId }).members.map((member) => member.agent_id)).not.toContain("claude:wk");
  });

  test("a present membership is not moved without the session's credential", async () => {
    const { service, supervisor, adapter, roomId, workerJoins, startWorker, advance } = await setup();
    const first = await startWorker();
    workerJoins(first);
    first.emit({ type: "exited", code: 1, signal: null });
    advance(10_000);
    await supervisor.tick();
    await supervisor.tick();
    expect(adapter.last.generation).toBe(2);
    expect(service.getRoomState({ room_id: roomId }).members.find((member) => member.agent_id === "claude:wk")?.harness_pid).toBe(first.pid);
  });
});

test("a resumed generation does not inherit the old process's stick or reservation", async () => {
  const { service, supervisor, adapter, roomId, dataDir, project, workerJoins, startWorker, advance } = await setup();
  const first = await startWorker();
  const joined = workerJoins(first);
  writeCliSessions(resolveCliSessionPath({ dataDir }), [{ agent_id: "claude:wk", room_id: roomId, canonical_path: project,
    workspace_root: project, recovery_credential: joined.recovery_credential, updated_at: "t" }]);
  service.joinPath({ agent_id: "codex:peer", context_path: project });
  expect((await service.waitForTurn({ room_id: roomId, agent_id: "claude:wk", max_wait_ms: 0 })).status).toBe("your_turn");
  first.emit({ type: "exited", code: null, signal: "SIGKILL" });
  advance(10_000);
  await supervisor.tick();
  await supervisor.tick();
  expect(adapter.last.generation).toBe(2);
  const state = service.getRoomState({ room_id: roomId });
  expect(state.members.find((member) => member.agent_id === "claude:wk")?.harness_pid).toBe(adapter.last.pid);
  expect(state.room).toMatchObject({ owner: null, lease_id: null });
  expect(service.getRoomEvents({ room_id: roomId, include_all: true }).some((event) =>
    event.event_type === "release" && event.reason === "process_replaced")).toBe(true);
});
