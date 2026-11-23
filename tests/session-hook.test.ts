import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { TalkingStickService } from "../src/service.js";
import { runSessionHookCommand } from "../src/cli/session-hook.js";
import { runAntigravityHookCommand } from "../src/cli/antigravity-hook.js";
import { mergeSessionHooks, planSessionHooks } from "../src/install.js";
import { resolveCliIdentity } from "../src/cli/identity.js";
import { parseCommand } from "../src/cli/parser.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

const setupMetadata = () => ({ harness_name: "claude", harness_session_id: "harness:old",
  harness_host_id: "local", harness_pid: 123, harness_process_started_at: "start" });

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-lifecycle-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = new TalkingStickService({ dbPath: path.join(root, "rooms.sqlite"), hostId: "local",
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
  expect(service.db.prepare("SELECT * FROM room_events WHERE reason = 'member_lost'").all()).toHaveLength(1);
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
  // Resuming is not enough: only the session's own explicit join recovers it.
  expect(() => join()).toThrow(expect.objectContaining({ code: "member_lost" }));
  expect(service.joinPath({ agent_id: "claude:old", context_path: root, process_metadata: setupMetadata(),
    recover: true, recovery_credentials: { [room.room_id]: room.recovery_credential! } }).recovered?.evidence).toBe("credential");
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
  const { service, root, join, metadata, hook, room } = setup();
  hook("SessionEnd");
  hook("SessionStart", { pid: 456, processStartedAt: "later" });
  const resumed = { ...metadata, harness_pid: 456, harness_process_started_at: "later" };
  expect(() => join("claude:old", resumed)).toThrow(expect.objectContaining({ code: "member_lost" }));
  expect(service.joinPath({ agent_id: "claude:old", context_path: root, process_metadata: resumed, recover: true,
    recovery_credentials: { [room.room_id]: room.recovery_credential! } }).recovered?.evidence).toBe("credential");
  expect(() => service.joinPath({ agent_id: "claude:old", context_path: root, process_metadata: metadata })).toThrow("session ended");
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

test("a nested Claude's hook ends its own session, not the outer one", async () => {
  const { service, join, metadata } = setup();
  join("claude:inner", { ...metadata, harness_session_id: "harness:inner",
    harness_pid: 200, harness_process_started_at: "inner-start" });
  const inspector = { inspect: (pid: number) => ({
    300: { pid, ppid: 200, command: "sh", startTime: "hook-start" },
    200: { pid, ppid: 150, command: "claude", startTime: "inner-start" },
    150: { pid, ppid: 123, command: "zsh", startTime: "shell-start" },
    123: { pid, ppid: 1, command: "claude", startTime: "start" }
  } as Record<number, { pid: number; ppid: number; command: string; startTime: string }>)[pid] ?? null };
  await runSessionHookCommand("claude", { service, inspector, parentPid: 300,
    stdin: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "inner" }) });
  expect(service.db.prepare("SELECT agent_id FROM room_members").all()).toEqual([{ agent_id: "claude:old" }]);
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

test("Grok snake-case event values bind through a shell to the Grok parent", async () => {
  const { service, join, metadata } = setup();
  join("grok:old", { ...metadata, harness_name: "grok" });
  const inspector = { inspect: (pid: number) => pid === 999
    ? { pid, ppid: 123, command: "bash", startTime: "shell" }
    : pid === 123 ? { pid, ppid: 1, command: "grok", startTime: "start" } : null };
  await runSessionHookCommand("grok", { service, inspector, parentPid: 999,
    stdin: JSON.stringify({ hookEventName: "session_end", sessionId: "old" }) });
  expect(service.db.prepare("SELECT agent_id FROM room_members").all()).toEqual([{ agent_id: "claude:old" }]);
  await runSessionHookCommand("grok", { service, inspector, parentPid: 999,
    stdin: JSON.stringify({ hookEventName: "session_start", sessionId: "old" }) });
  expect(() => join("grok:old", { ...metadata, harness_name: "grok" })).not.toThrow();
});

test("Antigravity installs in a native hook group and preserves foreign groups", () => {
  const original = '{"herdr":{"Stop":[{"type":"command","command":"herdr hook"}]}}';
  const installed = mergeSessionHooks(original, "antigravity")!;
  const settings = JSON.parse(installed);
  expect(Object.keys(settings["shrooms-antigravity"])).toEqual(["SessionStart", "PreInvocation", "Stop"]);
  expect(settings["shrooms-antigravity"].Stop[0].command).toContain("tt antigravity-hook Stop");
  expect(mergeSessionHooks(installed, "antigravity")).toBe(installed);
  expect(mergeSessionHooks(installed.replace("tt antigravity-hook Stop", "tt old-hook Stop"), "antigravity")).toBe(installed);
  expect(JSON.parse(mergeSessionHooks(installed, "antigravity", true)!)).toEqual(JSON.parse(original));
  expect(mergeSessionHooks('{"shrooms-antigravity":[]}', "antigravity")).toBeNull();
});

test("Antigravity hook setup works before the vendor config directory exists", () => {
  const options = { homeDir: "/home/agent", skipMissing: true,
    pathExists: () => false, which: (command: string) => command === "agy" ? "/bin/agy" : null };
  expect(planSessionHooks("antigravity", "install", options)).toEqual([
    expect.objectContaining({ kind: "file-patch", filePath: path.join(options.homeDir, ".gemini", "config", "hooks.json") })
  ]);
});

test("Antigravity hooks deliver only to the exact conversation and do not end it at Stop", async () => {
  const { service, root, room, join, metadata } = setup();
  const agent = "agy:active";
  join(agent, { ...metadata, harness_name: "antigravity", harness_session_id: "harness:active" });
  join("agy:other", { ...metadata, harness_name: "antigravity", harness_session_id: "harness:other" });
  service.sendMessage({ room_id: room.room_id, agent_id: "claude:old", to_agent_id: agent, body: "for active" });
  const output: string[] = [];
  const run = (event: string, id: string, startTime = "start", terminationReason = "NO_TOOL_CALL") =>
    runAntigravityHookCommand(event, {
      service, parentPid: 123, stdout: text => output.push(text),
      inspector: { inspect: () => ({ pid: 123, ppid: 1, command: "agy", startTime }) },
      stdin: JSON.stringify({ conversationId: id, cwd: root, workspacePaths: [path.dirname(root)], fullyIdle: true, terminationReason })
    });
  await run("SessionStart", "active");
  await run("Stop", "other");
  await run("Stop", "active", "different");
  await run("Stop", "active", "start", "CANCELLED");
  expect(output).toEqual([]);
  await run("Stop", "active");
  expect(JSON.parse(output[0])).toMatchObject({ decision: "continue", reason: expect.stringContaining("for active") });
  await run("Stop", "active");
  expect(output).toHaveLength(1);
  expect(service.db.prepare("SELECT agent_id FROM room_members WHERE agent_id LIKE 'agy:%'").all())
    .toEqual([{ agent_id: "agy:active" }, { agent_id: "agy:other" }]);
});

test("Antigravity keeps the old ID for an enrolled conversation without reusing it for another", () => {
  const { service, root } = setup();
  const parsed = parseCommand(["whoami"]);
  const env = { ANTIGRAVITY_AGENT: "1", ANTIGRAVITY_CONVERSATION_ID: "existing", TALKING_STICK_DATA_DIR: root };
  const { identity } = resolveCliIdentity(parsed, env);
  const oldId = identity.agent_id.replace(/^agy:/, "antigravity:");
  service.joinPath({ context_path: root, agent_id: oldId, process_metadata: identity.process_metadata });
  expect(resolveCliIdentity(parsed, env).identity.agent_id).toBe(oldId);
  expect(resolveCliIdentity(parsed, { ...env, ANTIGRAVITY_CONVERSATION_ID: "new" }).identity.agent_id)
    .toMatch(/^agy:/);
});
