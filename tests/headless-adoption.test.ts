import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { TalkingStickService } from "../src/service.js";
import { resolveCliSessionPath, writeCliSessions } from "../src/session-store.js";
import { SupervisorStore } from "../src/supervisor/state.js";
import { Supervisor } from "../src/supervisor/daemon.js";
import { createRoomBridge } from "../src/supervisor/room-bridge.js";
import { adoptionWorkerId, type AdoptableHarness } from "../src/supervisor/adoption.js";
import type { ProcessInspection } from "../src/process-utils.js";
import type { WorkerSpec } from "../src/supervisor/adapter.js";
import { FakeAdapter } from "./fixtures/supervisor-fake.js";

const HOST = "fixture-host";
const START = "prior-start";
const SESSION = "fixture-session";
const SOURCE_PID = 101;
const OPERATOR = "human:fixture:chat:1";
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function setup(harness: AdoptableHarness = "claude", command: string = harness === "antigravity" ? "agy" : harness) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-adopt-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, "workspace");
  fs.mkdirSync(cwd);
  const agentId = `${harness === "antigravity" ? "agy" : harness}:fixture`;
  let inspection: ProcessInspection | null | undefined = { pid: SOURCE_PID, ppid: 3, startTime: START, command };
  const service = new TalkingStickService({ dataDir: dir, hostId: HOST,
    adoptionInspector: { inspect: (pid) => pid === SOURCE_PID ? inspection : undefined },
    processLivenessChecker: () => "alive", receiverLivenessChecker: () => "gone" });
  cleanups.push(() => service.close());
  const store = new SupervisorStore(path.join(dir, "supervisor.sqlite"));
  cleanups.push(() => store.close());
  const adapter = new FakeAdapter(harness);
  const bridge = createRoomBridge(service, { dataDir: dir, hostId: HOST });
  // Leave wake work queued so the tests can inspect the committed room state.
  // The command smoke exercises the real intake socket and delivery.
  delete bridge.flushAdoption;
  const supervisor = new Supervisor({ store, adapters: { [harness]: adapter }, bridge,
    socketPath: path.join(dir, "sv.sock"), processLiveness: () => "alive", bootstrap: true });
  cleanups.push(() => supervisor.shutdown());
  supervisor.reconcileStartup();
  const meta = { host_id: HOST, pid: SOURCE_PID, process_started_at: START,
    harness_name: harness, harness_host_id: HOST, harness_pid: SOURCE_PID,
    harness_process_started_at: START, harness_session_id: `harness:${SESSION}`, session_kind: "harness_cli" as const };
  const join = () => service.joinPath({ agent_id: agentId, context_path: cwd, process_metadata: meta });
  const joined = join();
  const roomId = joined.room_id;
  const credential = joined.recovery_credential!;
  const workerId = adoptionWorkerId(roomId, agentId);
  writeCliSessions(resolveCliSessionPath({ dataDir: dir }), [{ agent_id: agentId, room_id: roomId,
    canonical_path: joined.canonical_path, workspace_root: cwd, context_path: cwd,
    event_cursor_seq: 2, recovery_credential: credential, updated_at: new Date().toISOString() }]);
  service.joinPath({ agent_id: OPERATOR, context_path: cwd,
    process_metadata: { host_id: HOST, pid: 19, process_started_at: "fixture", session_kind: "human_chat" } });
  service.db.prepare("UPDATE room_members SET wait_intent = 'parked' WHERE room_id = ? AND agent_id = ?").run(roomId, agentId);
  const spec: WorkerSpec = { worker_id: workerId, harness, cwd, env: [],
    permissions: harness === "codex" ? { harness, sandbox: "read-only", approval: "on-request" } : { harness, mode: "default" },
    adoption: { room_id: roomId, agent_id: agentId } };
  const reserve = () => service.beginHeadlessAdoption(roomId, agentId, workerId, credential);
  const queue = () => { reserve(); store.addWorker(spec, OPERATOR, new Date().toISOString()); };
  return { service, store, adapter, bridge, supervisor, roomId, workerId, agentId, reserve, queue, join, credential, cwd,
    gone: () => { inspection = null; }, unknown: () => { inspection = undefined; } };
}

describe("adopting an exact interactive conversation", () => {
  test.each(["claude", "antigravity", "codex"] as const)("waits for exact %s process exit and then resumes once without bootstrap", async (harness) => {
    const f = setup(harness);
    f.queue();
    expect(f.reserve().process).toBe("alive");
    await Promise.all([f.supervisor.tick(), f.supervisor.tick()]);
    expect(f.adapter.handles).toHaveLength(0);
    expect(() => f.join()).toThrow("moving to the supervisor");
    await expect(f.service.waitForTurn({ room_id: f.roomId, agent_id: f.agentId })).rejects.toThrow("moving to the supervisor");
    expect(f.service.getRoomState({ room_id: f.roomId }).members.find(member => member.agent_id === f.agentId))
      .toMatchObject({ headless_handoff: "pending", harness_pid: SOURCE_PID });
    const sent = f.service.sendMessage({ agent_id: OPERATOR, room_id: f.roomId, to_agent_id: f.agentId, body: "held until handoff" });
    f.gone();
    await Promise.all([f.supervisor.tick(), f.supervisor.tick()]);
    expect(f.adapter.handles).toHaveLength(1);
    expect(f.adapter.last.spec.resume_session_id).toBe(SESSION);
    expect(f.adapter.last.submitted).toEqual([]);
    expect(f.store.latestGeneration(f.workerId)?.state).toBe("idle");
    expect(f.service.getRoomState({ room_id: f.roomId }).members.find(member => member.agent_id === f.agentId))
      .toMatchObject({ harness_pid: f.adapter.last.pid, harness_session_id: `harness:${SESSION}` });
    expect(f.service.db.prepare("SELECT wake_pending FROM member_wake_endpoints WHERE room_id = ? AND agent_id = ? AND transport = 'supervisor'")
      .get(f.roomId, f.agentId)).toEqual({ wake_pending: 1 });
    expect(f.service.db.prepare("SELECT consumed_at FROM native_event_receipts WHERE room_id = ? AND agent_id = ? AND event_seq = ?")
      .get(f.roomId, f.agentId, sent.event_seq)).toEqual({ consumed_at: null });
  });

  test("refuses a desktop app-server, unknown process, and a stick reservation", () => {
    const shared = setup("codex", "codex app-server --listen unix://");
    expect(() => shared.reserve()).toThrow("shared or unverified");
    const unknown = setup();
    unknown.unknown();
    expect(() => unknown.reserve()).toThrow("Can't verify");
    const reserved = setup();
    reserved.service.db.prepare("UPDATE path_rooms SET reserved_for = ? WHERE room_id = ?").run(reserved.agentId, reserved.roomId);
    expect(() => reserved.reserve()).toThrow("up next");
  });

  test("holds a failed handshake and leaves the original conversation recoverable", async () => {
    const f = setup();
    f.queue();
    f.gone();
    f.adapter.failStart = () => true;
    await f.supervisor.tick();
    expect(f.store.worker(f.workerId)?.hold_reason).toBe("resume_failed");
    expect(f.store.latestGeneration(f.workerId)?.session_id).toBe(SESSION);
    expect(f.service.readHeadlessAdoption(f.workerId)?.state).toBe("failed");
    expect(f.service.getRoomState({ room_id: f.roomId }).members.find(member => member.agent_id === f.agentId))
      .toMatchObject({ harness_pid: SOURCE_PID });
    expect(() => f.store.requestRestart(f.workerId, true, OPERATOR, "now")).toThrow("keeps its conversation");
  });

  test("stops the new process if the original membership is kicked during the native handshake", async () => {
    const f = setup();
    f.queue();
    f.gone();
    let finish!: () => void;
    f.adapter.holdStart = new Promise<void>((resolve) => { finish = resolve; });
    const tick = f.supervisor.tick();
    f.service.kickMember({ room_id: f.roomId, agent_id: OPERATOR, target_agent_id: f.agentId, force: true });
    finish();
    await tick;
    expect(f.adapter.last.stopped).toBe(true);
    expect(f.store.worker(f.workerId)?.hold_reason).toBe("resume_failed");
    expect(f.service.getRoomState({ room_id: f.roomId }).members.some(member => member.agent_id === f.agentId)).toBe(false);
  });

  test("keeps received and uncertain receipts while dispatching only new events", async () => {
    const f = setup("antigravity");
    const send = (body: string) => f.service.sendMessage({
      agent_id: OPERATOR, room_id: f.roomId, to_agent_id: f.agentId, body
    }).event_seq;
    const prepare = () => f.service.prepareHarnessHookDelivery({ harness: "antigravity",
      context_path: f.cwd, harness_session_id: `harness:${SESSION}`, pid: SOURCE_PID, processStartedAt: START });
    const received = send("already read");
    expect(prepare()).toContain("already read");
    const prior = f.service.db.prepare<[], { token: string }>("SELECT token FROM native_delivery_batches").get()!;
    f.service.acknowledgeNativeDelivery({ token: prior.token, agent_id: f.agentId,
      harness_session_id: `harness:${SESSION}`, host_id: HOST });
    const uncertain = send("unconfirmed");
    expect(prepare()).toContain("unconfirmed");
    f.queue();
    const fresh = send("new work");
    expect(prepare()).toBeNull();
    f.gone();
    await f.supervisor.tick();
    const receipts = f.service.db.prepare<[], { event_seq: number; consumed_at: string | null }>(
      "SELECT event_seq, consumed_at FROM native_event_receipts ORDER BY event_seq").all();
    expect(receipts).toEqual([
      { event_seq: received, consumed_at: expect.any(String) }, { event_seq: uncertain, consumed_at: null },
      { event_seq: fresh, consumed_at: null }
    ]);
    expect(f.service.db.prepare("SELECT event_seqs_json FROM native_delivery_batches WHERE delivery_mode = 'adoption_uncertain'").get())
      .toEqual({ event_seqs_json: JSON.stringify([uncertain]) });
    const notices = f.service.getRoomEvents({ room_id: f.roomId }).filter(event => event.event_type === "headless_adoption");
    expect(notices.at(-1)?.reason).toContain("1 uncertain");
  });

  test("recovers a lost membership and keeps messages sent while it was lost", async () => {
    const f = setup();
    f.service.recordSessionLifecycle({ harness: "claude", sessionId: SESSION, pid: SOURCE_PID, processStartedAt: START,
      event: "SessionEnd", processKind: "single_session" });
    f.gone();
    const sent = f.service.sendMessage({ agent_id: OPERATOR, room_id: f.roomId, to_agent_id: f.agentId, body: "sent while lost" });
    f.queue();
    await f.supervisor.tick();
    expect(f.service.readHeadlessAdoption(f.workerId)?.state).toBe("complete");
    expect(f.service.db.prepare("SELECT consumed_at FROM native_event_receipts WHERE room_id = ? AND agent_id = ? AND event_seq = ?")
      .get(f.roomId, f.agentId, sent.event_seq)).toEqual({ consumed_at: null });
  });
});
