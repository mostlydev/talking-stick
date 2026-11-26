import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { TalkingStickService, type NativeWakeRequest, type NativeWakeResult, type VisitorReturnAddressInput } from "../src/index.js";

const HOST = "fixture-host";
const MEMBER = "agy:worker";
const OPERATOR = "human:operator";
const ALPHA = "codex:alpha";
const BETA = "codex:latest";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-overseer-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspace = path.join(dir, "room");
  fs.mkdirSync(workspace);
  const requests: NativeWakeRequest[] = [];
  let outcome: NativeWakeResult = { outcome: "queued" };
  const uncertain = new Set<string>();
  const service = new TalkingStickService({ dataDir: path.join(dir, "data"), hostId: HOST,
    processLivenessChecker: proc => uncertain.has(proc.harness_session_id ?? "") ? "unknown" : "alive",
    nativeWakeTransport: { deliver(request) {
      if (request.transport === "codex_queue" && !request.on_queue?.()) return { outcome: "failed", error: "not_admitted" };
      requests.push(request);
      return outcome;
    } } });
  cleanup.push(() => service.close());
  const roomId = service.joinPath({ agent_id: MEMBER, context_path: workspace }).room_id;
  const endpoint = (name: string): VisitorReturnAddressInput => ({
    transport: "codex_queue", address: name, secret: null, harness_session_id: `harness:${name}`, host_id: HOST,
    pid: 1000 + name.length, process_started_at: "exact start"
  });
  const register = (alias: string, actor: string) => service.registerOverseer({
    alias, agent_id: actor, endpoint: endpoint(alias)
  });
  const designate = (alias: string | null) => service.setRoomOverseer({ room_id: roomId, agent_id: OPERATOR, alias });
  const open = (body: string, goal_id?: string) => service.addBlocker({ room_id: roomId, agent_id: MEMBER, body, goal_id });
  const rows = () => service.db.prepare<[], { event_seq: number; status: string; token: string }>(
    "SELECT event_seq, status, token FROM overseer_deliveries ORDER BY event_seq").all();
  return { dir, workspace, service, roomId, requests, endpoint, register, designate, open, uncertain, rows,
    setOutcome: (value: NativeWakeResult) => { outcome = value; } };
}

test("captures only the explicit designation and sends every lifecycle event once", async () => {
  const f = setup();
  f.register("alpha", ALPHA);
  f.register("latest", BETA);
  await f.service.askRoom({ room_id: f.roomId, agent_id: BETA, to: [MEMBER], body: "What are you doing?",
    return_address: f.endpoint("latest") });
  const previous = f.open("Before designation");
  await f.service.flushWakes();
  expect(f.requests).toEqual([]);
  expect(f.rows()).toEqual([]);
  f.designate("alpha");
  const goal = f.service.addGoal({ room_id: f.roomId, agent_id: ALPHA, brief: "Build", completion_criterion: "Tests pass" });
  const blocker = f.open("Can we use the clean builder?", goal.goal_id);
  expect(f.open(blocker.body, goal.goal_id)).toEqual(blocker);
  const withdraw = { room_id: f.roomId, agent_id: MEMBER, blocker_id: blocker.blocker_id, reason: "Builder available" };
  f.service.withdrawBlocker(withdraw);
  f.service.withdrawBlocker(withdraw);
  const resolution = { room_id: f.roomId, agent_id: OPERATOR, resolves: previous.blocker_id, body: "Proceed." };
  const resolved = await f.service.sendMessageAndWake(resolution);
  expect((await f.service.sendMessageAndWake(resolution)).event_seq).toBe(resolved.event_seq);
  const exit = { room_id: f.roomId, agent_id: MEMBER, goal_id: goal.goal_id, status: "done" as const, evidence: "Tests passed at 123abcd" };
  const closed = f.service.closeGoal(exit);
  f.service.closeGoal(exit);
  await Promise.all([f.service.flushWakes(), f.service.flushWakes(), f.service.flushWakes()]);
  const rows = f.rows();
  expect(rows).toHaveLength(4);
  expect(rows.map(row => row.event_seq)).toEqual(expect.arrayContaining([resolved.event_seq, closed.closure_event_seq]));
  expect(f.requests).toHaveLength(4);
  for (const request of f.requests) expect(request).toMatchObject({ address: "alpha", steer: false, interrupt: false, start_queued: true });
  const text = f.requests.map(request => request.text).join("\n");
  expect(text).toContain("B2 · goal G1 · opened");
  expect(text).toContain("B2 · goal G1 · withdrawn");
  expect(text).toContain("resolves B1");
  expect(text).toContain("G1 · done\n  Tests passed at 123abcd");
  expect(f.service.getRoomOverseer(f.roomId)).toMatchObject({ pending: 0, unconfirmed: 4, failed: 0 });
  const ack = { agent_id: ALPHA, token: rows[0].token, harness_session_id: "harness:alpha", host_id: HOST };
  expect(() => f.service.acknowledgeNativeDelivery({ ...ack, harness_session_id: "harness:latest" })).toThrow("does not belong");
  expect(f.service.acknowledgeNativeDelivery(ack)).toEqual({ status: "acknowledged", event_seqs: [rows[0].event_seq] });
  expect(f.service.acknowledgeNativeDelivery(ack).status).toBe("already_acknowledged");
  expect(f.service.getRoomOverseer(f.roomId)?.unconfirmed).toBe(3);
  expect(f.service.getRoomState({ room_id: f.roomId }).members.map(member => member.agent_id)).toEqual([MEMBER]);
});

test("reassignment cancels undelivered work and never redirects old events", async () => {
  const f = setup();
  f.register("alpha", ALPHA);
  f.register("latest", BETA);
  expect(() => f.service.setRoomOverseer({ room_id: f.roomId, agent_id: MEMBER, alias: "alpha" })).toThrow("Only the operator");
  f.designate("alpha");
  f.open("First question");
  expect(f.service.getRoomOverseer(f.roomId)?.pending).toBe(1);
  f.designate("latest");
  await f.service.flushWakes();
  expect(f.rows()).toMatchObject([{ status: "failed" }]);
  expect(f.requests).toEqual([]);
  f.open("Second question");
  await f.service.flushWakes();
  expect(f.requests.map(request => request.address)).toEqual(["latest"]);
  f.designate(null);
  expect(f.service.getRoomOverseer(f.roomId)).toBeNull();
  expect(f.requests).toHaveLength(1);
});

test("refuses to wake uncertain processes and does not retry an ambiguous write", async () => {
  const f = setup();
  f.register("alpha", ALPHA);
  f.designate("alpha");
  f.uncertain.add("harness:alpha");
  f.open("Needs decisions");
  await f.service.flushWakes();
  f.uncertain.delete("harness:alpha");
  await f.service.flushWakes();
  expect(f.requests).toEqual([]);
  expect(f.service.getRoomOverseer(f.roomId)).toMatchObject({ reachable: true, failed: 1 });
  expect(f.rows()).toMatchObject([{ status: "failed" }]);
  f.setOutcome({ outcome: "ambiguous", error: "codex_queue_timeout" });
  f.open("A separate question");
  await f.service.flushWakes();
  await f.service.flushWakes();
  expect(f.requests).toHaveLength(1);
  expect(f.rows().at(-1)?.status).toBe("ambiguous");
  expect(f.service.getRoomOverseer(f.roomId)?.unconfirmed).toBe(1);
});

test("registration and membership are mutually exclusive for the native session", () => {
  const f = setup();
  const meta = { harness_host_id: HOST, harness_session_id: "harness:alpha" };
  f.service.joinPath({ agent_id: "claude:old-id", context_path: f.workspace, process_metadata: meta });
  expect(() => f.register("alpha", ALPHA)).toThrow("Leave room membership");
  f.service.leaveRoom({ room_id: f.roomId, agent_id: "claude:old-id" });
  const registered = f.register("alpha", ALPHA);
  expect(f.register("alpha", ALPHA)).toEqual(registered);
  expect(JSON.stringify(registered)).not.toMatch(/address|secret|harness_session_id/);
  expect(() => f.service.joinPath({ agent_id: "codex:new-id", context_path: f.workspace, process_metadata: meta }))
    .toThrow("Unregister");
  expect(() => f.register("alpha", BETA)).toThrow("already registered");
  f.designate("alpha");
  expect(() => f.service.unregisterOverseer({ alias: "alpha", agent_id: BETA })).toThrow("Only the registered session or operator");
  expect(f.service.unregisterOverseer({ alias: "alpha", agent_id: ALPHA, host_id: HOST, harness_session_id: "harness:alpha" })).toBe(true);
  expect(f.service.getRoomOverseer(f.roomId)).toBeNull();
  expect(f.service.joinPath({ agent_id: ALPHA, context_path: f.workspace, process_metadata: meta }).room_id).toBe(f.roomId);
});

test("retains pull events even without a native designation", () => {
  const f = setup();
  const blocker = f.open("Still visible");
  f.service.withdrawBlocker({ room_id: f.roomId, agent_id: MEMBER, blocker_id: blocker.blocker_id, reason: "No longer relevant." });
  expect(f.rows()).toEqual([]);
  expect(f.service.getRecentRoomEvents({ room_id: f.roomId, limit: 10, event_types: ["blocker_added", "blocker_withdrawn"] })
    .map(row => row.blocker)).toEqual([
    { blocker_id: blocker.blocker_id, goal_id: null, status: "open", body: "Still visible" },
    { blocker_id: blocker.blocker_id, goal_id: null, status: "withdrawn", reason: "No longer relevant." }
  ]);
});
