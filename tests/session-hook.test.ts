import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { TalkingStickService } from "../src/service.js";
import { runSessionHookCommand } from "../src/cli/session-hook.js";
import { mergeSessionHooks } from "../src/install.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-lifecycle-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = new TalkingStickService({ dbPath: path.join(root, "state.sqlite"), hostId: "local",
    processLivenessChecker: () => "alive", receiverLivenessChecker: () => "alive" });
  cleanup.push(() => service.close());
  const metadata = { harness_name: "claude", harness_session_id: "harness:old",
    harness_host_id: "local", harness_pid: 123, harness_process_started_at: "start" };
  const join = (agent = "claude:old", process_metadata = metadata) => service.joinPath({
    agent_id: agent, context_path: root, process_metadata });
  const room = join();
  const hook = (event: "SessionStart" | "SessionEnd", overrides = {}) => service.recordSessionLifecycle({
    event, harness: "claude", sessionId: "old", pid: 123, processStartedAt: " start ", ...overrides });
  return { service, root, metadata, join, room, hook };
}

test("end removes only the exact session and revokes its lease without collapsing shared-PID peers", async () => {
  const { service, join, metadata, room, hook } = setup();
  join("claude:other", { ...metadata, harness_session_id: "harness:other" });
  join("claude:remote", { ...metadata, harness_host_id: "remote" });
  join("claude:reused", { ...metadata, harness_process_started_at: "later" });
  const claim = await service.waitForTurn({ room_id: room.room_id, agent_id: "claude:old", max_wait_ms: 0 });
  expect(claim.status).toBe("your_turn");
  service.registerNativeWakeEndpoint({ room_id: room.room_id, agent_id: "claude:old",
    transport: "claude_inbox", address: "/tmp/test.sock", secret: "test",
    harness_session_id: "harness:old", host_id: "local" });
  expect(hook("SessionEnd")).toBe(1);
  expect(service.db.prepare("SELECT agent_id FROM room_members ORDER BY agent_id").all()).toEqual([
    { agent_id: "claude:other" }, { agent_id: "claude:remote" }, { agent_id: "claude:reused" }
  ]);
  expect(service.db.prepare("SELECT owner, lease_id FROM path_rooms").get()).toEqual({ owner: null, lease_id: null });
  expect(service.db.prepare("SELECT * FROM member_wake_endpoints").all()).toEqual([]);
  expect(hook("SessionEnd")).toBe(0);
  expect(service.db.prepare("SELECT * FROM room_events WHERE reason = 'session_ended'").all()).toHaveLength(1);
});

test("old wait cannot resurrect a retired member, even without metadata; exact resume allows rejoin", () => {
  const { service, join, room, hook, root } = setup();
  hook("SessionEnd");
  expect(() => join()).toThrow("session ended");
  expect(() => service.joinPath({ context_path: root, agent_id: "claude:old" })).toThrow("session ended");
  expect(() => service.registerReceiver({ room_id: room.room_id, agent_id: "claude:old",
    receiver_id: "late", host_id: "local", pid: 555, process_started_at: "late", cursor_event_seq: 0
  })).toThrow("must join the room");
  hook("SessionStart", { sessionId: "other" });
  expect(() => join()).toThrow("session ended");
  hook("SessionStart");
  expect(join().room_id).toBe(room.room_id);
});

test("retirement revokes an unclaimed reservation while preserving other members", () => {
  const { service, room, hook, join, metadata } = setup();
  join("claude:other", { ...metadata, harness_session_id: "harness:other" });
  service.db.prepare("UPDATE path_rooms SET reserved_for = ?, state = 'reserved', claim_expires_at = ? WHERE room_id = ?")
    .run("claude:old", "2099-01-01T00:00:00Z", room.room_id);
  hook("SessionEnd");
  expect(service.db.prepare("SELECT reserved_for, claim_expires_at, state FROM path_rooms").get())
    .toEqual({ reserved_for: null, claim_expires_at: null, state: "idle" });
});

test.each(["alive", "unknown", "gone"] as const)("aged tombstone GC with %s exact process", (liveness) => {
  const { service, root, hook } = setup();
  hook("SessionEnd");
  service.db.prepare("UPDATE ended_harness_sessions SET ended_at = '2000-01-01T00:00:00Z'").run();
  const observer = new TalkingStickService({ db: service.db, hostId: "local",
    processLivenessChecker: () => liveness });
  observer.joinPath({ agent_id: "human:observer", context_path: root });
  expect(service.db.prepare("SELECT * FROM ended_harness_sessions").all()).toHaveLength(liveness === "gone" ? 0 : 1);
  expect(service.db.prepare("SELECT * FROM ended_room_members").all()).toHaveLength(1);
});

test("new verified identities never retire existing sessions merely by sharing a process", () => {
  const { service, join, metadata, hook } = setup();
  hook("SessionStart", { sessionId: "new" });
  join("claude:new", { ...metadata, harness_session_id: "harness:new" });
  expect(service.db.prepare("SELECT * FROM room_members").all()).toHaveLength(2);
});

test("resume in a new process permits that session but keeps the old process tombstoned", () => {
  const { join, metadata, hook } = setup();
  hook("SessionEnd");
  hook("SessionStart", { pid: 456, processStartedAt: "later" });
  expect(() => join("claude:old", { ...metadata, harness_pid: 456, harness_process_started_at: "later" })).not.toThrow();
  expect(() => join()).toThrow("session ended");
});

test("hook requires exact ancestry and rejects malformed and child payloads, failing open", async () => {
  const { service } = setup();
  const inspector = { inspect: (pid: number) => pid === 123
    ? { pid, ppid: 1, command: "claude", startTime: "start" } : null };
  const run = (input: unknown, parentPid = 123) => runSessionHookCommand("claude", {
    service, inspector, parentPid, stdin: typeof input === "string" ? input : JSON.stringify(input) });
  await run("bad json");
  await run({ hook_event_name: "SessionEnd", session_id: "old" }, 999);
  await run({ hook_event_name: "SessionEnd", session_id: "old", agent_id: "child" });
  expect(service.db.prepare("SELECT * FROM room_members").all()).toHaveLength(1);
  await run({ hook_event_name: "SessionEnd", session_id: "old", reason: "clear" });
  expect(service.db.prepare("SELECT * FROM room_members").all()).toHaveLength(0);
});

test("installer preserves foreign hooks even in a shared entry and is idempotent", () => {
  const foreign = { type: "command", command: "my-hook" };
  const original = JSON.stringify({ other: 42, hooks: { SessionEnd: [{ matcher: "clear", hooks: [foreign] }] } });
  const installed = mergeSessionHooks(original, "claude")!;
  expect(mergeSessionHooks(installed, "claude")).toBe(installed);
  expect(JSON.parse(mergeSessionHooks(installed, "claude", true)!)).toEqual(JSON.parse(original));
  const combined = JSON.parse(installed);
  combined.hooks.SessionEnd[1].hooks.push(foreign);
  const removed = JSON.parse(mergeSessionHooks(JSON.stringify(combined), "claude", true)!);
  expect(removed.hooks.SessionEnd[1].hooks).toEqual([foreign]);
  expect(mergeSessionHooks('{"hooks":[]}', "codex")).toBeNull();
  expect(mergeSessionHooks('{"hooks":{"SessionEnd":1}}', "codex")).toBeNull();
});
