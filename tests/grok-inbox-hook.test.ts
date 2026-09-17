import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { TalkingStickService } from "../src/service.js";
import { runGrokInboxHookCommand } from "../src/cli/grok-inbox-hook.js";

const roots: string[] = [];
const services: TalkingStickService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-inbox-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  const service = new TalkingStickService({ dataDir: path.join(root, "data"), hostId: "test-host", processLivenessChecker: () => "alive" });
  services.push(service);
  const room = service.joinPath({ agent_id: "human:op", context_path: root });
  service.joinPath({ agent_id: "grok:test", context_path: root, process_metadata: {
    harness_name: "grok", harness_session_id: "harness:grok-session", host_id: "test-host", harness_host_id: "test-host"
  } });
  const send = (body: string) => service.sendMessage({ agent_id: "human:op", room_id: room.room_id, to_agent_id: "grok:test", body });
  const hook = async (overrides: Record<string, unknown> = {}) => {
    let output = "";
    await runGrokInboxHookCommand({ service, stdout: text => { output += text; }, stdin: JSON.stringify({
      hookEventName: "post_tool_use", sessionId: "grok-session", cwd: root, ...overrides
    }) });
    return output ? JSON.parse(output).hookSpecificOutput : null;
  };
  const ack = (text: string) => service.acknowledgeNativeDelivery({ agent_id: "grok:test",
    token: text.match(/Ack: tt ack ([a-f0-9-]+)/)![1], harness_session_id: "harness:grok-session", host_id: "test-host" });
  return { root, service, room, send, hook, ack };
}

test("post-tool delivery includes exact events; ack prevents replay and never grants a turn", async () => {
  const { service, room, send, hook, ack } = setup();
  const sent = send("steer the work");
  const output = await hook();
  expect(output.hookEventName).toBe("PostToolUse");
  expect(output.additionalContext).toContain("steer the work");
  expect(output.additionalContext).toContain(sent.event_id);
  expect(service.getMessageReceipts({ room_id: room.room_id, event_seqs: [sent.event_seq] })).toEqual([]);
  expect(await hook()).toBeNull();
  ack(output.additionalContext);
  expect(await hook()).toBeNull();
  const read = await service.waitForEvents({ room_id: room.room_id, agent_id: "grok:test", after_event_seq: sent.event_seq - 1, max_wait_ms: 0 });
  expect(read.events).toEqual([]);
  expect(service.db.prepare("SELECT owner FROM path_rooms WHERE room_id = ?").get(room.room_id)).toMatchObject({ owner: null });
});

test("later arrivals follow acknowledgement and hooks retry an expired reservation", async () => {
  const { service, room, send, hook, ack } = setup();
  send("first");
  const first = await hook();
  send("second");
  expect(await hook()).toBeNull();
  ack(first.additionalContext);
  const second = await hook({ hookEventName: "post_tool_use_failure" });
  expect(second.hookEventName).toBe("PostToolUseFailure");
  expect(second.additionalContext).toContain("second");
  expect(second.additionalContext).not.toContain('"body":"first"');
  service.db.prepare("UPDATE native_delivery_batches SET created_at = ? WHERE room_id = ? AND source = 'grok_hook'")
    .run(new Date(Date.now() - 61_000).toISOString(), room.room_id);
  expect((await hook()).additionalContext).toContain("second");
});

test("Stop delivers non-error feedback only at a first normal turn end", async () => {
  const { send, hook } = setup();
  send("one more instruction");
  for (const overrides of [
    { hookEventName: "stop" },
    { hookEventName: "stop", reason: "shutdown" },
    { hookEventName: "subagent_stop", reason: "end_turn" },
    { hookEventName: "stop", reason: "end_turn", stopHookActive: true },
    { hookEventName: "stop", reason: "end_turn", subagentType: "explore" }
  ]) expect(await hook(overrides)).toBeNull();
  const output = await hook({ hookEventName: "stop", reason: "end_turn" });
  expect(output.hookEventName).toBe("Stop");
  expect(output.additionalContext).toContain("one more instruction");
});

test("envelopes are paged under hook capacity without truncating bodies", async () => {
  const { send, hook, ack } = setup();
  send("a".repeat(4000));
  send("b".repeat(4000));
  const first = await hook();
  expect(Buffer.byteLength(first.additionalContext)).toBeLessThanOrEqual(8000);
  expect(first.additionalContext).toContain("a".repeat(4000));
  expect(first.additionalContext).not.toContain("b".repeat(4000));
  ack(first.additionalContext);
  expect((await hook()).additionalContext).toContain("b".repeat(4000));
});

test("wrong session, foreign host, unknown events and broken inputs fail open", async () => {
  const { service, room, send, hook } = setup();
  send("unread");
  expect(await hook({ sessionId: "other-session" })).toBeNull();
  expect(await hook({ hookEventName: "pre_tool_use" })).toBeNull();
  service.db.prepare("UPDATE room_members SET harness_host_id = 'elsewhere' WHERE room_id = ? AND agent_id = 'grok:test'").run(room.room_id);
  expect(await hook()).toBeNull();
  for (const stdin of ["not json", "null", "[]", "{}"] ) {
    let output = "";
    await runGrokInboxHookCommand({ service, stdin, stdout: text => { output += text; } });
    expect(output).toBe("");
  }
});

test("normal wait consumption releases a hook reservation without native ack", async () => {
  const { service, room, send, hook } = setup();
  const first = send("read through wait");
  await hook();
  await service.waitForEvents({ room_id: room.room_id, agent_id: "grok:test", after_event_seq: first.event_seq - 1, max_wait_ms: 0 });
  send("next message");
  expect((await hook()).additionalContext).toContain("next message");
});

test("oversized events use a bounded pull notice and remain readable", async () => {
  const { service, room, send, hook } = setup();
  const body = "<".repeat(4000);
  const sent = send(body);
  const output = await hook();
  expect(output.additionalContext).toContain("exceeds hook capacity");
  expect(output.additionalContext).not.toContain("Ack:");
  expect(await hook()).toBeNull();
  const read = await service.waitForEvents({ room_id: room.room_id, agent_id: "grok:test", after_event_seq: sent.event_seq - 1, max_wait_ms: 0 });
  expect(JSON.stringify(read.events)).toContain(body);
  send("after the large event");
  expect((await hook()).additionalContext).toContain("after the large event");
});

test("concurrent hooks reserve one envelope and database errors fail open", async () => {
  const { service, send, hook } = setup();
  send("once");
  const outputs = await Promise.all([hook(), hook(), hook()]);
  expect(outputs.filter(Boolean)).toHaveLength(1);
  service.db.prepare("DROP TABLE native_delivery_batches").run();
  expect(await hook()).toBeNull();
});

test("ambiguous membership never delivers another member's events", async () => {
  const { service, root, send, hook } = setup();
  send("bound to the original member");
  service.joinPath({ agent_id: "grok:other", context_path: root, process_metadata: {
    harness_name: "grok", harness_session_id: "harness:grok-session", host_id: "test-host", harness_host_id: "test-host"
  } });
  expect(await hook()).toBeNull();
});


test("urgent events are available to hooks before external dispatch", async () => {
  const { service, room, hook } = setup();
  service.sendMessage({ room_id: room.room_id, agent_id: "human:op", to_agent_id: "grok:test", body: "urgent steering", delivery_hint: "interrupt" });
  expect((await hook()).additionalContext).toContain("urgent steering");
});
