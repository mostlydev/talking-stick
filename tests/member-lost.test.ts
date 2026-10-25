import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { classifyHarnessProcess } from "../src/service.js";
import {
  TalkingStickService,
  type NativeWakeRequest,
  type NativeWakeResult,
  type ProcessLiveness,
  type ProcessMetadata
} from "../src/index.js";

const HOST = "host-l";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

const OP = "human:op:chat:1";

function metadata(harness: string, session: string, overrides: Partial<ProcessMetadata> = {}): ProcessMetadata {
  return {
    host_id: HOST, pid: 700, process_started_at: "Sun Oct 25 08:00:00 2026", session_kind: "harness_cli",
    display_name: harness, harness_name: harness, harness_session_id: `harness:${session}`, harness_host_id: HOST,
    harness_pid: 600, harness_process_started_at: "Sun Oct 25 07:00:00 2026", ...overrides
  };
}

function setup(options: { native?: (request: NativeWakeRequest) => NativeWakeResult } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-member-lost-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "package.json"), "{}\n");
  let now = new Date("2026-10-25T12:00:00.000Z");
  const liveness: Record<string, ProcessLiveness> = {};
  const nativeRequests: NativeWakeRequest[] = [];
  const service = new TalkingStickService({
    dataDir: path.join(root, "data"), hostId: HOST, now: () => now,
    policy: { waitForTurnPollMs: 2 },
    processLivenessChecker: (meta) => liveness[meta.harness_session_id ?? ""] ?? "alive",
    receiverLivenessChecker: () => "gone",
    nativeWakeTransport: { deliver(request) {
      nativeRequests.push(request);
      return options.native ? options.native(request) : { outcome: "woken" };
    } },
    wakeTransport: { deliver() { return { delivered: false, definite_failure: true }; } }
  });
  cleanup.push(() => { service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const roomId = service.joinPath({ agent_id: OP, context_path: project,
    process_metadata: { host_id: HOST, pid: 10, process_started_at: "t", session_kind: "human_chat", display_name: "op" } }).room_id;
  const join = (agent: string, meta: ProcessMetadata, extra: { recover?: boolean; credential?: string } = {}) =>
    service.joinPath({ agent_id: agent, context_path: project, process_metadata: meta,
      ...(extra.recover ? { recover: true, recovery_credentials: extra.credential ? { [roomId]: extra.credential } : {} } : {}) });
  const hook = (event: "SessionStart" | "SessionEnd", harness: string, session: string,
    overrides: { pid?: number; start?: string; command?: string; reason?: string } = {}) =>
    service.recordSessionLifecycle({ event, harness, sessionId: session, pid: overrides.pid ?? 600,
      processStartedAt: overrides.start ?? "Sun Oct 25 07:00:00 2026", hookReason: overrides.reason ?? null,
      processKind: classifyHarnessProcess(harness, overrides.command ?? harness) });
  const members = () => service.getRoomState({ room_id: roomId }).members.map((member) => member.agent_id).sort();
  const lost = () => service.getRoomState({ room_id: roomId }).lost_members ?? [];
  const setNow = (iso: string) => { now = new Date(iso); };
  return { service, project, roomId, join, hook, members, lost, liveness, nativeRequests, setNow };
}

function registerInbox(service: TalkingStickService, roomId: string, agent: string, session: string) {
  service.registerNativeWakeEndpoint({ agent_id: agent, room_id: roomId, transport: "claude_inbox",
    address: "/tmp/inbox.sock", secret: "inbox-token", harness_session_id: `harness:${session}`, host_id: HOST });
}

describe("a SessionEnd for an open session", () => {
  test("keeps the member as lost: removed, lease released, and told how to recover", async () => {
    const { service, roomId, join, hook, members, lost } = setup();
    const joined = join("claude:aa", metadata("claude", "s1"));
    expect(joined.recovery_credential).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(join("claude:aa", metadata("claude", "s1")).recovery_credential).toBeUndefined();
    join("codex:bb", metadata("codex", "s2", { harness_pid: 601 }));
    const turn = await service.waitForTurn({ room_id: roomId, agent_id: "claude:aa", max_wait_ms: 0 });
    expect(turn.status).toBe("your_turn");

    expect(hook("SessionEnd", "claude", "s1", { reason: "other" })).toBe(1);
    expect(members()).toEqual(["codex:bb", OP]);
    expect(service.getRoomState({ room_id: roomId }).room).toMatchObject({ owner: null, lease_id: null });
    expect(lost()).toEqual([expect.objectContaining({ agent_id: "claude:aa", hook_reason: "other" })]);
    expect(service.getRoomEvents({ room_id: roomId, include_all: true }).at(-1))
      .toMatchObject({ event_type: "leave", from_agent_id: "claude:aa", reason: "member_lost" });

    // Every other call from that session, including a listener, is refused with the way back.
    for (const call of [
      () => service.registerStandby({ room_id: roomId, agent_id: "claude:aa", transport: "manual" }),
      () => service.sendMessage({ room_id: roomId, agent_id: "claude:aa", body: "here?" }),
      () => join("claude:aa", metadata("claude", "s1"))
    ]) {
      expect(call).toThrow(expect.objectContaining({ code: "member_lost",
        details: expect.objectContaining({ recover_with: "tt join --json" }) }));
    }
    const log = service.db.prepare("SELECT event, hook_reason, process_kind, outcome FROM harness_lifecycle_log").all();
    expect(log).toEqual([{ event: "SessionEnd", hook_reason: "other", process_kind: "single_session", outcome: "lost claude:aa" }]);
  });

  test("the same session's explicit join recovers it without a lease, and replays what it missed once", async () => {
    const { service, roomId, join, hook, members } = setup();
    const credential = join("claude:aa", metadata("claude", "s1")).recovery_credential!;
    join("codex:bb", metadata("codex", "s2", { harness_pid: 601 }));
    await service.waitForTurn({ room_id: roomId, agent_id: "claude:aa", max_wait_ms: 0 });
    const before = service.getLatestEventSeq({ room_id: roomId });
    hook("SessionEnd", "claude", "s1");
    const direct = await service.sendMessageAndWake({ agent_id: OP, room_id: roomId, to_agent_id: "claude:aa", body: "while lost" });
    const room = await service.sendMessageAndWake({ agent_id: "codex:bb", room_id: roomId, body: "room while lost" });

    const recovered = join("claude:aa", metadata("claude", "s1"), { recover: true, credential });
    expect(recovered.recovered).toMatchObject({ evidence: "credential", replay_from_event_seq: before });
    expect(recovered.recovery_credential).toBeUndefined();
    expect(members()).toEqual(["claude:aa", "codex:bb", OP]);
    expect(recovered.room_state).toMatchObject({ owner: null, lease_id: null });
    const replayed = service.getRoomEvents({ room_id: roomId, after_event_seq: recovered.recovered!.replay_from_event_seq, include_all: true })
      .filter((event) => event.event_type === "message_sent").map((event) => event.event_seq);
    expect(replayed).toEqual([direct.event_seq, room.event_seq]);
    expect(service.getRoomEvents({ room_id: roomId, include_all: true }).at(-1))
      .toMatchObject({ event_type: "join", from_agent_id: "claude:aa", reason: "recovered" });
    // Recovered once: the next join is ordinary.
    expect(join("claude:aa", metadata("claude", "s1"), { recover: true, credential }).recovered).toBeUndefined();
  });

  test("a resumed process recovers only with the credential and its own SessionStart", () => {
    const { join, hook } = setup();
    const credential = join("claude:aa", metadata("claude", "s1")).recovery_credential!;
    hook("SessionEnd", "claude", "s1");
    const resumed = metadata("claude", "s1", { harness_pid: 650, harness_process_started_at: "Sun Oct 25 13:00:00 2026" });
    expect(() => join("claude:aa", resumed, { recover: true, credential }))
      .toThrow("has not reported starting the session");
    hook("SessionStart", "claude", "s1", { pid: 650, start: "Sun Oct 25 13:00:00 2026" });
    expect(() => join("claude:aa", resumed, { recover: true })).toThrow("credential issued to this session is missing");
    expect(() => join("claude:aa", resumed, { recover: true, credential: "wrong" })).toThrow("does not match");
    expect(() => join("claude:aa", resumed)).toThrow(expect.objectContaining({ code: "member_lost" }));
    expect(join("claude:aa", resumed, { recover: true, credential }).recovered?.evidence).toBe("credential");
    // The old process stays retired.
    expect(() => join("claude:aa", metadata("claude", "s1"))).toThrow("session ended");
  });

  test("a session never issued a credential recovers on its exact process, or on its own SessionStart", () => {
    const { service, roomId, join, hook } = setup();
    join("claude:aa", metadata("claude", "s1"));
    service.db.prepare("DELETE FROM member_credentials").run();
    hook("SessionEnd", "claude", "s1");
    const other = metadata("claude", "s1", { harness_pid: 650, harness_process_started_at: "later" });
    expect(() => join("claude:aa", other, { recover: true })).toThrow("has not reported starting the session");
    expect(join("claude:aa", metadata("claude", "s1"), { recover: true }).recovered?.evidence).toBe("process_identity");
    expect(service.getRoomState({ room_id: roomId }).members.map((member) => member.agent_id)).toContain("claude:aa");
  });

  test("restores the same delivery batches and receipts, so a late acknowledgement stays deduplicated", async () => {
    const { service, roomId, join, hook } = setup({ native: () => ({ outcome: "queued" }) });
    const credential = join("claude:aa", metadata("claude", "s1")).recovery_credential!;
    registerInbox(service, roomId, "claude:aa", "s1");
    await service.sendMessageAndWake({ agent_id: OP, room_id: roomId, to_agent_id: "claude:aa", body: "before loss" });
    const tables = ["member_wake_endpoints", "native_delivery_batches", "native_event_receipts"];
    const snapshot = () => Object.fromEntries(tables.map((table) =>
      [table, service.db.prepare(`SELECT * FROM ${table} WHERE agent_id = 'claude:aa'`).all()]));
    const before = snapshot();
    expect(before.native_delivery_batches).toHaveLength(1);
    const token = (before.native_delivery_batches[0] as { token: string }).token;

    hook("SessionEnd", "claude", "s1");
    expect(service.db.prepare("SELECT * FROM native_delivery_batches").all()).toHaveLength(0);
    expect(() => service.acknowledgeNativeDelivery({ agent_id: "claude:aa", token, harness_session_id: "harness:s1", host_id: HOST }))
      .toThrow();
    join("claude:aa", metadata("claude", "s1"), { recover: true, credential });
    expect(snapshot()).toEqual(before);
    const ack = () => service.acknowledgeNativeDelivery({ agent_id: "claude:aa", token, harness_session_id: "harness:s1", host_id: HOST });
    expect(ack().status).toBe("acknowledged");
    expect(ack().status).toBe("already_acknowledged");
  });

  test("receipts for events pruned while lost are dropped and reported, not a failed recovery", async () => {
    const { service, roomId, join, hook } = setup({ native: () => ({ outcome: "queued" }) });
    const credential = join("claude:aa", metadata("claude", "s1")).recovery_credential!;
    registerInbox(service, roomId, "claude:aa", "s1");
    const sent = await service.sendMessageAndWake({ agent_id: OP, room_id: roomId, to_agent_id: "claude:aa", body: "pruned" });
    hook("SessionEnd", "claude", "s1");
    service.db.prepare("DELETE FROM room_events WHERE event_seq <= ?").run(sent.event_seq);
    const recovered = join("claude:aa", metadata("claude", "s1"), { recover: true, credential }).recovered!;
    expect(recovered.dropped_receipts).toBe(1);
    expect(recovered.gap).toBeDefined();
    expect(service.db.prepare("SELECT * FROM native_event_receipts").all()).toEqual([]);
    expect(service.db.prepare("SELECT * FROM native_delivery_batches").all()).toHaveLength(1);
  });

  test("a resumed process gets the batches back but not the old process's endpoint", async () => {
    const { service, roomId, join, hook } = setup({ native: () => ({ outcome: "queued" }) });
    const credential = join("claude:aa", metadata("claude", "s1")).recovery_credential!;
    registerInbox(service, roomId, "claude:aa", "s1");
    await service.sendMessageAndWake({ agent_id: OP, room_id: roomId, to_agent_id: "claude:aa", body: "before loss" });
    hook("SessionEnd", "claude", "s1");
    hook("SessionStart", "claude", "s1", { pid: 650, start: "later" });
    join("claude:aa", metadata("claude", "s1", { harness_pid: 650, harness_process_started_at: "later" }), { recover: true, credential });
    expect(service.db.prepare("SELECT * FROM member_wake_endpoints").all()).toHaveLength(0);
    expect(service.db.prepare("SELECT * FROM native_delivery_batches").all()).toHaveLength(1);
  });
});

describe("explicit removal of a lost member", () => {
  test.each(["kick", "leave"] as const)("%s is final: no recovery, even after the session starts again", (removal) => {
    const { service, roomId, join, hook, lost } = setup();
    const credential = join("claude:aa", metadata("claude", "s1")).recovery_credential!;
    hook("SessionEnd", "claude", "s1");
    if (removal === "kick") {
      expect(service.kickMember({ room_id: roomId, agent_id: OP, target_agent_id: "claude:aa", force: true }).status).toBe("kicked");
    } else {
      expect(service.leaveRoom({ room_id: roomId, agent_id: "claude:aa" }).status).toBe("left");
    }
    expect(lost()).toEqual([]);
    expect(service.db.prepare("SELECT * FROM member_credentials WHERE agent_id = 'claude:aa'").all()).toEqual([]);
    const refused = expect.objectContaining({ code: "member_revoked" });
    expect(() => join("claude:aa", metadata("claude", "s1"), { recover: true, credential })).toThrow(refused);
    // A later SessionStart, in the same or a new process, does not undo it.
    hook("SessionStart", "claude", "s1");
    expect(() => join("claude:aa", metadata("claude", "s1"), { recover: true, credential })).toThrow(refused);
    expect(() => join("claude:aa", metadata("claude", "s1"))).toThrow(refused);
    hook("SessionStart", "claude", "s1", { pid: 650, start: "later" });
    expect(() => join("claude:aa", metadata("claude", "s1", { harness_pid: 650, harness_process_started_at: "later" }),
      { recover: true, credential })).toThrow(refused);
    // A new harness session is a different member and joins normally.
    expect(() => join("claude:new", metadata("claude", "s9", { harness_pid: 660 }))).not.toThrow();
  });

  test("an old binary's join or leave after the loss supersedes the snapshot without duplicating membership", () => {
    const { service, roomId, join, hook, lost, members } = setup();
    join("claude:aa", metadata("claude", "s1"));
    hook("SessionEnd", "claude", "s1");
    // An older tt clears the tombstones on SessionStart and rejoins without knowing about lost members.
    service.db.prepare("DELETE FROM ended_room_members").run();
    service.db.prepare("DELETE FROM ended_harness_sessions").run();
    service.db.prepare(`INSERT INTO room_events (event_id, room_id, turn_id, event_type, from_agent_id, created_at)
      VALUES ('old-binary-join', ?, 0, 'join', 'claude:aa', '2026-10-25T12:00:01.000Z')`).run(roomId);
    expect(lost()).toEqual([]);
    expect(join("claude:aa", metadata("claude", "s1"), { recover: true }).recovered).toBeUndefined();
    expect(members()).toEqual(["claude:aa", OP]);
    expect(service.db.prepare("SELECT * FROM lost_room_members").all()).toEqual([]);
  });
});

describe("messages to a lost member", () => {
  test("a direct message is kept for it, and its open session gets one recovery notice", async () => {
    const { service, roomId, join, hook, nativeRequests, setNow, lost } = setup();
    join("claude:aa", metadata("claude", "s1"));
    registerInbox(service, roomId, "claude:aa", "s1");
    hook("SessionEnd", "claude", "s1");
    const first = await service.sendMessageAndWake({ agent_id: OP, room_id: roomId, to_agent_id: "claude:aa", body: "one" });
    expect(first.held).toEqual([expect.objectContaining({ agent_id: "claude:aa", reason: "member_lost", notice: "injected" })]);
    expect(first.deliveries).toBeUndefined();
    expect(nativeRequests).toHaveLength(1);
    expect(nativeRequests[0]).toMatchObject({ transport: "claude_inbox", address: "/tmp/inbox.sock" });
    expect(nativeRequests[0].text).toContain("tt join --json");
    expect(nativeRequests[0].text).not.toContain("one");
    const second = await service.sendMessageAndWake({ agent_id: OP, room_id: roomId, to_agent_id: "claude:aa", body: "two" });
    expect(second.held?.[0].notice).toBe("already_sent");
    expect(nativeRequests).toHaveLength(1);
    setNow("2026-10-25T12:31:00.000Z");
    await service.sendMessageAndWake({ agent_id: OP, room_id: roomId, to_agent_id: "claude:aa", body: "three" });
    expect(nativeRequests).toHaveLength(2);
    expect(lost()[0]).toMatchObject({ notice_status: "injected", notice_at: "2026-10-25T12:31:00.000Z" });
  });

  test("two connections sending at once deliver one notice; an unfinished one re-arms after the interval", async () => {
    let release!: (result: NativeWakeResult) => void;
    let calls = 0;
    const { service, roomId, join, hook, setNow, lost } = setup({ native: () => {
      calls++;
      return new Promise<NativeWakeResult>((resolve) => { release = resolve; }) as unknown as NativeWakeResult;
    } });
    join("claude:aa", metadata("claude", "s1"));
    registerInbox(service, roomId, "claude:aa", "s1");
    hook("SessionEnd", "claude", "s1");
    const dataDir = (service as unknown as { dataDir: string }).dataDir;
    const second = new TalkingStickService({ dataDir, hostId: HOST, now: () => new Date("2026-10-25T12:00:05.000Z"),
      processLivenessChecker: () => "alive", receiverLivenessChecker: () => "gone",
      nativeWakeTransport: { deliver() { calls++; return { outcome: "woken" }; } } });
    cleanup.push(() => second.close());
    const first = service.sendMessageAndWake({ agent_id: OP, room_id: roomId, to_agent_id: "claude:aa", body: "one" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBe(1);
    const other = await second.sendMessageAndWake({ agent_id: OP, room_id: roomId, to_agent_id: "claude:aa", body: "two" });
    expect(other.held?.[0].notice).toBe("already_sent");
    expect(lost()[0].notice_status).toBe("sending");
    release({ outcome: "woken" });
    expect((await first).held?.[0].notice).toBe("injected");
    expect(calls).toBe(1);

    // A reservation whose sender died stays ambiguous until the interval passes.
    service.db.prepare("UPDATE lost_room_members SET notice_status = 'sending'").run();
    expect((await second.sendMessageAndWake({ agent_id: OP, room_id: roomId, to_agent_id: "claude:aa", body: "three" }))
      .held?.[0].notice).toBe("already_sent");
    setNow("2026-10-25T12:31:00.000Z");
    const later = service.sendMessageAndWake({ agent_id: OP, room_id: roomId, to_agent_id: "claude:aa", body: "four" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    release({ outcome: "woken" });
    expect((await later).held?.[0].notice).toBe("injected");
    expect(calls).toBe(2);
  });

  test("a queued Codex notice is reported queued, not delivered", async () => {
    const { service, roomId, join, hook } = setup({ native: () => ({ outcome: "queued" }) });
    join("codex:bb", metadata("codex", "s2"));
    service.registerNativeWakeEndpoint({ agent_id: "codex:bb", room_id: roomId, transport: "codex_queue",
      address: "thread-1", secret: null, harness_session_id: "harness:s2", host_id: HOST });
    hook("SessionEnd", "codex", "s2", { command: "codex --yolo" });
    const sent = await service.sendMessageAndWake({ agent_id: OP, room_id: roomId, to_agent_id: "codex:bb", body: "hi" });
    expect(sent.held?.[0].notice).toBe("queued");
  });

  test("no notice when the process is not running or has no native endpoint", async () => {
    const { service, roomId, join, hook, liveness, nativeRequests } = setup();
    join("claude:aa", metadata("claude", "s1"));
    registerInbox(service, roomId, "claude:aa", "s1");
    join("codex:bb", metadata("codex", "s2", { harness_pid: 601 }));
    hook("SessionEnd", "claude", "s1");
    hook("SessionEnd", "codex", "s2", { pid: 601 });
    liveness["harness:s1"] = "gone";
    const sent = await service.sendMessageAndWake({ agent_id: OP, room_id: roomId, to_agent_ids: ["claude:aa", "codex:bb"], body: "hi" });
    expect(Object.fromEntries((sent.held ?? []).map((held) => [held.agent_id, held.notice])))
      .toEqual({ "claude:aa": "process_not_running", "codex:bb": "unreachable" });
    expect(nativeRequests).toHaveLength(0);
  });

  test("room messages report lost members; only the operator's notifies them", async () => {
    const { service, roomId, join, hook, nativeRequests } = setup();
    join("claude:aa", metadata("claude", "s1"));
    registerInbox(service, roomId, "claude:aa", "s1");
    join("codex:bb", metadata("codex", "s2", { harness_pid: 601 }));
    hook("SessionEnd", "claude", "s1");
    const agent = await service.sendMessageAndWake({ agent_id: "codex:bb", room_id: roomId, body: "room" });
    expect(agent.held).toEqual([{ agent_id: "claude:aa", reason: "member_lost", lost_at: "2026-10-25T12:00:00.000Z" }]);
    expect(nativeRequests).toHaveLength(0);
    const operator = await service.sendMessageAndWake({ agent_id: OP, room_id: roomId, body: "everyone" });
    expect(operator.held?.[0].notice).toBe("injected");
    expect(operator.deliveries?.map((delivery) => delivery.agent_id)).toEqual(["codex:bb"]);
  });

  test("a visitor's question to a lost member is kept and notified", async () => {
    const { service, roomId, join, hook } = setup();
    join("claude:aa", metadata("claude", "s1"));
    registerInbox(service, roomId, "claude:aa", "s1");
    hook("SessionEnd", "claude", "s1");
    const asked = await service.askRoom({ agent_id: "codex:visitor", room_id: roomId, to: ["claude:aa"], body: "status?" });
    expect(asked.recipients).toEqual(["claude:aa"]);
    expect(asked.held?.[0]).toMatchObject({ agent_id: "claude:aa", notice: "injected" });
  });
});

describe("what ends a lost membership", () => {
  test("another session starting in the same one-session process ends it; a shared host does not", () => {
    const { join, hook, lost } = setup();
    join("claude:aa", metadata("claude", "s1"));
    join("codex:bb", metadata("codex", "s2", { harness_pid: 601 }));
    hook("SessionEnd", "claude", "s1");
    hook("SessionEnd", "codex", "s2", { pid: 601, command: "codex app-server --listen stdio://" });
    hook("SessionStart", "codex", "s3", { pid: 601, command: "codex app-server --listen stdio://" });
    hook("SessionStart", "claude", "s4", { command: "/Users/me/.local/bin/claude" });
    expect(lost().map((member) => member.agent_id)).toEqual(["codex:bb"]);
  });

  test("Grok sessions are removed as before and never become lost", async () => {
    const { service, roomId, join, hook, lost } = setup();
    join("grok:cc", metadata("grok", "s5"));
    hook("SessionEnd", "grok", "s5");
    expect(lost()).toEqual([]);
    expect(() => service.sendMessage({ agent_id: OP, room_id: roomId, to_agent_id: "grok:cc", body: "hi" }))
      .toThrow(expect.objectContaining({ code: "unknown_recipient" }));
    expect(service.getRoomEvents({ room_id: roomId, include_all: true }).at(-1)).toMatchObject({ reason: "session_ended" });
  });

  test("the exact process ending still removes it after the gone grace", () => {
    const { service, project, roomId, join, hook, liveness, setNow, lost } = setup();
    join("claude:aa", metadata("claude", "s1"));
    hook("SessionEnd", "claude", "s1");
    liveness["harness:s1"] = "gone";
    setNow("2026-10-25T13:01:00.000Z");
    service.joinPath({ agent_id: "human:probe", context_path: project });
    setNow("2026-10-25T14:02:00.000Z");
    service.joinPath({ agent_id: "human:probe", context_path: project });
    expect(lost()).toEqual([]);
    expect(service.db.prepare("SELECT * FROM lost_room_members").all()).toEqual([]);
    expect(service.getRoomState({ room_id: roomId }).members.map((member) => member.agent_id)).not.toContain("claude:aa");
  });
});

describe("a session never issued a credential", () => {
  test("recovers in a resumed process on that process's SessionStart, as before credentials", () => {
    const { service, join, hook } = setup();
    join("claude:aa", metadata("claude", "s1"));
    service.db.prepare("DELETE FROM member_credentials").run();
    hook("SessionEnd", "claude", "s1");
    const resumed = metadata("claude", "s1", { harness_pid: 650, harness_process_started_at: "later" });
    hook("SessionStart", "claude", "s1", { pid: 650, start: "later" });
    expect(join("claude:aa", resumed, { recover: true }).recovered?.evidence).toBe("session_start");
  });
});

describe("the CLI's cache after a recovery", () => {
  test("keeps a surviving cursor, falls back to the loss cursor, saves the credential privately and drops the stale lease", async () => {
    const { upsertSessionFromJoin } = await import("../src/cli/session.js");
    const { readCliSessions, writeCliSessions, resolveCliSessionPath } = await import("../src/index.js");
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-member-lost-cli-"));
    const previous = process.env.TALKING_STICK_DATA_DIR;
    process.env.TALKING_STICK_DATA_DIR = dataDir;
    cleanup.push(() => {
      if (previous === undefined) delete process.env.TALKING_STICK_DATA_DIR;
      else process.env.TALKING_STICK_DATA_DIR = previous;
      fs.rmSync(dataDir, { recursive: true, force: true });
    });
    const sessionPath = resolveCliSessionPath();
    const identity = { agent_id: "claude:aa", process_metadata: metadata("claude", "s1") };
    const recovered = { lost_at: "t", hook_reason: null, evidence: "credential" as const, replay_from_event_seq: 10 };
    const joined = (room: string) => ({ room_id: room, canonical_path: `/p/${room}`, workspace_root: `/p/${room}`,
      cursor_event_seq: 30, recovered });
    writeCliSessions(sessionPath, [{ agent_id: "claude:aa", room_id: "r1", canonical_path: "/p/r1", workspace_root: "/p/r1",
      event_cursor_seq: 20, lease_id: "old-lease", turn_id: 7, guardian_pid: 99, updated_at: "t" }]);
    upsertSessionFromJoin(identity, joined("r1"));
    upsertSessionFromJoin(identity, { ...joined("r2"), recovery_credential: "secret" });
    const sessions = Object.fromEntries(readCliSessions(sessionPath).map((session) => [session.room_id, session]));
    expect(sessions.r1).toMatchObject({ event_cursor_seq: 20 });
    expect(sessions.r1).not.toHaveProperty("lease_id");
    expect(sessions.r1).not.toHaveProperty("guardian_pid");
    expect(sessions.r2).toMatchObject({ event_cursor_seq: 10, recovery_credential: "secret" });
    if (process.platform !== "win32") expect(fs.statSync(sessionPath).mode & 0o777).toBe(0o600);
  });
});

test("tt msg send resolves a lost member's exact id, and nothing looser", async () => {
  const { resolveAgentSelector } = await import("../src/cli/event-stream.js");
  const runtime = { commands: { getRoomState: () => ({ members: [], lost_members: [
    { agent_id: "claude:aa", harness_name: "claude", lost_at: "t", hook_reason: null, notice_status: null, notice_at: null }
  ] }) } } as never;
  const identity = { agent_id: "human:op", process_metadata: {} } as never;
  expect(resolveAgentSelector(runtime, identity, "room", "claude:aa")).toBe("claude:aa");
  expect(() => resolveAgentSelector(runtime, identity, "room", "claude")).toThrow("No active room member matches");
});
