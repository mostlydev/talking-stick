import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { TalkingStickService } from "../src/index.js";

const MEMBER = "claude:worker";
const MANAGER = "codex:manager";
const OPERATOR = "human:operator";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-goals-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = new Date("2026-11-26T12:00:00Z");
  const service = new TalkingStickService({ dataDir: path.join(root, "data"), now: () => now,
    policy: { idleRoomTtlMs: 1_000 }, processLivenessChecker: () => "unknown" });
  cleanup.push(() => service.close());
  const project = (name: string) => {
    const contextPath = path.join(root, name);
    fs.mkdirSync(contextPath);
    return service.joinPath({ agent_id: MEMBER, context_path: contextPath }).room_id;
  };
  const roomId = project("one");
  const goal = (room_id = roomId) => service.addGoal({ room_id, agent_id: MANAGER,
    brief: "Audit the checkout instructions", completion_criterion: "A clean checkout can run the documented build" });
  return { service, roomId, project, goal, advance: () => { now = new Date(now.getTime() + 2_000); } };
}

test("allocates room-scoped IDs and records the outside manager without joining", async () => {
  const { service, roomId, project, goal } = fixture();
  const one = goal();
  expect(one).toMatchObject({ goal_id: "G1", status: "open", created_by: MANAGER, evidence: null });
  expect(goal().goal_id).toBe("G2");
  const other = project("two");
  expect(() => service.getGoal({ room_id: other, goal_id: one.goal_id })).toThrow("No goal G1 in this room");
  expect(goal(other).goal_id).toBe("G1");
  expect(service.getRoomState({ room_id: roomId }).members.map(member => member.agent_id)).toEqual([MEMBER]);
  const events = await service.waitForEvents({ room_id: roomId, agent_id: MEMBER, target_agent_id: "self",
    event_type: "goal_added", max_wait_ms: 0 });
  expect(events.events).toHaveLength(2);
  expect(events.events[0].goal).toEqual({ goal_id: "G1", status: "open", brief: one.brief, completion_criterion: one.completion_criterion });
  expect(() => service.addGoal({ room_id: roomId, agent_id: MEMBER, brief: "Describe the work", completion_criterion: " " }))
    .toThrow("completion criterion");
  expect(service.listGoals({ room_id: roomId })).toHaveLength(2);
});

test("commits one closure event and reuses its sequence on identical retries", () => {
  const { service, roomId, goal } = fixture();
  goal();
  const done = { room_id: roomId, goal_id: "G1", agent_id: MEMBER, status: "done" as const, evidence: "Clean build at abc1234." };
  const closed = service.closeGoal(done);
  expect(closed).toMatchObject({ status: "done", evidence: done.evidence, closed_by: MEMBER, closure_event_seq: expect.any(Number) });
  expect(service.closeGoal(done)).toEqual(closed);
  expect(() => service.closeGoal({ ...done, evidence: "Different result" })).toThrow("already done");
  expect(service.listGoals({ room_id: roomId })).toEqual([]);
  expect(service.listGoals({ room_id: roomId, all: true })).toEqual([closed]);
  const events = service.getRecentRoomEvents({ room_id: roomId, event_types: ["goal_closed"], limit: 10 });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ event_seq: closed.closure_event_seq, payload: null,
    goal: { goal_id: "G1", status: "done", evidence: done.evidence } });
});

test("rolls back the closure event if the goal update fails", () => {
  const { service, roomId, goal } = fixture();
  goal();
  service.db.exec("CREATE TRIGGER refuse_goal_close BEFORE UPDATE ON room_goals BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  expect(() => service.closeGoal({ room_id: roomId, agent_id: MEMBER, goal_id: "G1", status: "failed", evidence: "Failed" }))
    .toThrow("fixture");
  expect(service.getGoal({ room_id: roomId, goal_id: "G1" }).status).toBe("open");
  expect(service.getRecentRoomEvents({ room_id: roomId, event_types: ["goal_closed"], limit: 10 })).toEqual([]);
});

test("a member reports a failed result and an outside creator can withdraw its goal", () => {
  const { service, roomId, goal } = fixture();
  goal(); goal();
  expect(() => service.closeGoal({ room_id: roomId, agent_id: MANAGER, goal_id: "G1", status: "done", evidence: "Claimed done." }))
    .toThrow("Only a room member or operator");
  expect(service.closeGoal({ room_id: roomId, agent_id: MEMBER, goal_id: "G1", status: "failed", evidence: "Build failed on a clean Mac." }).status)
    .toBe("failed");
  expect(service.closeGoal({ room_id: roomId, agent_id: MANAGER, goal_id: "G2", status: "withdrawn", evidence: "The launch moved." }).status)
    .toBe("withdrawn");
});

test("links blockers to a local open goal without conflating identical requests", () => {
  const { service, roomId, project, goal } = fixture();
  goal(); goal();
  const another = project("two");
  const draft = { room_id: roomId, agent_id: MEMBER, body: "May we use a clean build machine?" };
  const first = service.addBlocker({ ...draft, goal_id: "g1" });
  const second = service.addBlocker({ ...draft, goal_id: "G2" });
  expect(first.goal_id).toBe("G1");
  expect(second.blocker_id).not.toBe(first.blocker_id);
  expect(service.addBlocker({ ...draft, goal_id: "G1" })).toEqual(first);
  expect(() => service.addBlocker({ ...draft, room_id: another, goal_id: "G1" })).toThrow("No goal G1 in this room");
  service.closeGoal({ room_id: roomId, agent_id: MEMBER, goal_id: "G1", status: "done", evidence: "Built independently." });
  expect(() => service.addBlocker({ ...draft, goal_id: "G1" })).toThrow("already done");
  expect(service.listBlockers({ room_id: roomId }).map(item => item.goal_id)).toEqual(["G1", "G2"]);
});

test("an open goal keeps an empty room until it is closed", () => {
  const { service, roomId, goal, advance } = fixture();
  goal();
  expect(service.leaveRoom({ room_id: roomId, agent_id: MEMBER }).status).toBe("left");
  advance();
  expect(service.listRooms().rooms.map(room => room.room_id)).toContain(roomId);
  expect(() => service.retireUnoccupiedRoom({ room_id: roomId })).toThrow("Close open goals");
  service.closeGoal({ room_id: roomId, agent_id: OPERATOR, goal_id: "G1", status: "done", evidence: "Verified clean build." });
  expect(service.listRooms().rooms.map(room => room.room_id)).toContain(roomId);
  advance();
  expect(service.listRooms().rooms.map(room => room.room_id)).not.toContain(roomId);
});
