import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  ProtocolError,
  TalkingStickService,
  type Handoff,
  type Policy,
  type RoomEvent,
  type WaitForTurnResult
} from "../src/index.js";

const tempRoots: string[] = [];
const services: TalkingStickService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) {
    service.close();
  }

  for (const tempRoot of tempRoots.splice(0)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe("out-of-band signaling substrate", () => {
  test("migration adds nullable payload_json to room_events", () => {
    const harness = createHarness();
    const columns = harness.service.db
      .prepare<[], { name: string }>("PRAGMA table_info(room_events)")
      .all()
      .map((row) => row.name);

    expect(columns).toContain("payload_json");
  });

  test("legacy room events map with null payload", async () => {
    const harness = createHarness();
    const room = joinPair(harness);
    const turn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: room.room_id,
        max_wait_ms: 0
      })
    );

    harness.service.releaseStick({
      room_id: room.room_id,
      agent_id: "codex:test",
      lease_id: turn.lease_id,
      expected_turn_id: turn.turn_id,
      handoff: validHandoff()
    });

    const events = harness.service.getRoomEvents({ room_id: room.room_id });
    expect(events.map((event) => event.event_type)).toEqual([
      "claim",
      "release"
    ]);
    expect(events.every((event) => event.payload === null)).toBe(true);
  });

  test("sendMessage writes direct message payloads", () => {
    const harness = createHarness();
    const room = joinPair(harness);

    const sent = harness.service.sendMessage({
      agent_id: "codex:test",
      room_id: room.room_id,
      to_agent_id: "claude:test",
      body: "look at token.ts",
      delivery_hint: "interrupt"
    });

    expect(sent.event_seq).toBeGreaterThan(0);
    expect(sent.event_id).toMatch(/^[0-9a-f-]+$/);

    const events = harness.service.getRoomEvents({ room_id: room.room_id });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_seq: sent.event_seq,
      event_id: sent.event_id,
      event_type: "message_sent",
      from_agent_id: "codex:test",
      to_agent_id: "claude:test",
      handoff: null,
      reason: null,
      payload: {
        body: "look at token.ts",
        delivery_hint: "interrupt"
      }
    });
  });

  test("sendMessage writes broadcast messages with null recipient", () => {
    const harness = createHarness();
    const room = joinPair(harness);

    harness.service.sendMessage({
      agent_id: "codex:test",
      room_id: room.room_id,
      body: "room-wide note"
    });

    const [event] = harness.service.getRoomEvents({ room_id: room.room_id });
    expect(event.to_agent_id).toBeNull();
    expect(event.payload).toEqual({
      body: "room-wide note",
      delivery_hint: "normal"
    });
  });

  test("sendMessage rejects invalid inputs without inserting events", () => {
    const harness = createHarness();
    const room = joinPair(harness);

    expect(() =>
      harness.service.sendMessage({
        agent_id: "codex:test",
        room_id: room.room_id,
        body: ""
      })
    ).toThrowProtocolError("invalid_body");

    expect(() =>
      harness.service.sendMessage({
        agent_id: "codex:test",
        room_id: room.room_id,
        body: "x".repeat(4097)
      })
    ).toThrowProtocolError("message_too_large");

    expect(() =>
      harness.service.sendMessage({
        agent_id: "codex:test",
        room_id: room.room_id,
        to_agent_id: "ghost:test",
        body: "hello"
      })
    ).toThrowProtocolError("unknown_recipient");

    expect(() =>
      harness.service.sendMessage({
        agent_id: "ghost:test",
        room_id: room.room_id,
        body: "hello"
      })
    ).toThrowProtocolError("unknown_member");

    expect(() =>
      harness.service.sendMessage({
        agent_id: "codex:test",
        room_id: room.room_id,
        body: "hello",
        delivery_hint: "urgent" as never
      })
    ).toThrowProtocolError("invalid_delivery_hint");

    expect(harness.service.getRoomEvents({ room_id: room.room_id })).toEqual([]);
  });

  test("sendMessage rejects closed rooms", () => {
    const harness = createHarness();
    const room = joinPair(harness);

    harness.service.db
      .prepare("UPDATE path_rooms SET state = 'closed' WHERE room_id = ?")
      .run(room.room_id);

    expect(() =>
      harness.service.sendMessage({
        agent_id: "codex:test",
        room_id: room.room_id,
        body: "hello"
      })
    ).toThrowProtocolError("room_closed");
  });

  test("waitForEvents returns matching events immediately and resumes by cursor", async () => {
    const harness = createHarness();
    const room = joinPair(harness);

    const first = harness.service.sendMessage({
      agent_id: "codex:test",
      room_id: room.room_id,
      to_agent_id: "claude:test",
      body: "first"
    });
    harness.service.sendMessage({
      agent_id: "codex:test",
      room_id: room.room_id,
      to_agent_id: "claude:test",
      body: "second"
    });

    const batch = await harness.service.waitForEvents({
      agent_id: "claude:test",
      room_id: room.room_id,
      event_type: "message_sent",
      target_agent_id: "self",
      max_wait_ms: 0
    });

    expect(messageBodies(batch.events)).toEqual(["first", "second"]);
    expect(batch.cursor_event_seq).toBe(batch.events[1].event_seq);

    const resumed = await harness.service.waitForEvents({
      agent_id: "claude:test",
      room_id: room.room_id,
      after_event_seq: first.event_seq,
      event_type: "message_sent",
      target_agent_id: "self",
      max_wait_ms: 0
    });

    expect(messageBodies(resumed.events)).toEqual(["second"]);
  });

  test("waitForEvents returns empty after deadline when no events match", async () => {
    const harness = createHarness();
    const room = joinPair(harness);

    const result = await harness.service.waitForEvents({
      agent_id: "claude:test",
      room_id: room.room_id,
      event_type: "message_sent",
      target_agent_id: "self",
      max_wait_ms: 0
    });

    expect(result).toEqual({ events: [], cursor_event_seq: 0 });
  });

  test("waitForEvents target self includes direct and other-authored broadcasts", async () => {
    const harness = createHarness();
    const room = joinPair(harness);

    harness.service.sendMessage({
      agent_id: "codex:test",
      room_id: room.room_id,
      to_agent_id: "claude:test",
      body: "direct"
    });
    harness.service.sendMessage({
      agent_id: "codex:test",
      room_id: room.room_id,
      body: "broadcast"
    });

    const result = await harness.service.waitForEvents({
      agent_id: "claude:test",
      room_id: room.room_id,
      event_type: "message_sent",
      target_agent_id: "self",
      max_wait_ms: 0
    });

    expect(messageBodies(result.events)).toEqual(["direct", "broadcast"]);
  });

  test("waitForEvents target self excludes own broadcasts but target any includes them", async () => {
    const harness = createHarness();
    const room = joinPair(harness);

    harness.service.sendMessage({
      agent_id: "codex:test",
      room_id: room.room_id,
      body: "self-authored broadcast"
    });

    const self = await harness.service.waitForEvents({
      agent_id: "codex:test",
      room_id: room.room_id,
      event_type: "message_sent",
      target_agent_id: "self",
      max_wait_ms: 0
    });
    expect(self.events).toEqual([]);

    const any = await harness.service.waitForEvents({
      agent_id: "codex:test",
      room_id: room.room_id,
      event_type: "message_sent",
      target_agent_id: "any",
      max_wait_ms: 0
    });
    expect(messageBodies(any.events)).toEqual(["self-authored broadcast"]);
  });

  test("waitForEvents target agent is strict and excludes broadcasts", async () => {
    const harness = createHarness();
    const room = joinPair(harness);

    harness.service.sendMessage({
      agent_id: "codex:test",
      room_id: room.room_id,
      to_agent_id: "claude:test",
      body: "direct"
    });
    harness.service.sendMessage({
      agent_id: "codex:test",
      room_id: room.room_id,
      body: "broadcast"
    });

    const result = await harness.service.waitForEvents({
      room_id: room.room_id,
      event_type: "message_sent",
      target_agent_id: "claude:test",
      max_wait_ms: 0
    });

    expect(messageBodies(result.events)).toEqual(["direct"]);
  });

  test("waitForEvents target self includes non-message events involving caller", async () => {
    const harness = createHarness();
    const room = joinPair(harness);
    const turn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: room.room_id,
        max_wait_ms: 0
      })
    );
    harness.service.passStick({
      room_id: room.room_id,
      agent_id: "codex:test",
      lease_id: turn.lease_id,
      expected_turn_id: turn.turn_id,
      to_agent_id: "claude:test",
      handoff: validHandoff()
    });

    const codexEvents = await harness.service.waitForEvents({
      agent_id: "codex:test",
      room_id: room.room_id,
      target_agent_id: "self",
      max_wait_ms: 0
    });
    expect(codexEvents.events.map((event) => event.event_type)).toEqual([
      "claim",
      "pass"
    ]);

    const claudeEvents = await harness.service.waitForEvents({
      agent_id: "claude:test",
      room_id: room.room_id,
      target_agent_id: "self",
      max_wait_ms: 0
    });
    expect(claudeEvents.events.map((event) => event.event_type)).toEqual([
      "pass"
    ]);
  });

  test("waitForEvents event type and sender filters are applied server-side", async () => {
    const harness = createHarness();
    const room = joinTrio(harness);

    harness.service.sendMessage({
      agent_id: "codex:test",
      room_id: room.room_id,
      to_agent_id: "claude:test",
      body: "from codex"
    });
    harness.service.sendMessage({
      agent_id: "gemini:test",
      room_id: room.room_id,
      to_agent_id: "claude:test",
      body: "from gemini"
    });

    const result = await harness.service.waitForEvents({
      agent_id: "claude:test",
      room_id: room.room_id,
      event_type: "message_sent",
      target_agent_id: "self",
      from_agent_id: "gemini:test",
      max_wait_ms: 0
    });

    expect(messageBodies(result.events)).toEqual(["from gemini"]);
    expect(result.cursor_event_seq).toBe(result.events[0].event_seq);
  });

  test("waitForEvents rejects invalid self and event-type filter inputs", async () => {
    const harness = createHarness();
    const room = joinPair(harness);

    await expectProtocolError(
      harness.service.waitForEvents({
        room_id: room.room_id,
        target_agent_id: "self",
        max_wait_ms: 0
      }),
      "agent_id_required"
    );

    await expectProtocolError(
      harness.service.waitForEvents({
        agent_id: "codex:test",
        room_id: room.room_id,
        event_type: [],
        max_wait_ms: 0
      }),
      "invalid_event_type_filter"
    );

    await expectProtocolError(
      harness.service.waitForEvents({
        agent_id: "codex:test",
        room_id: room.room_id,
        event_type: "unknown" as never,
        max_wait_ms: 0
      }),
      "invalid_event_type_filter"
    );
  });

  test("waitForEvents target=self refreshes presence but not wait-interest", async () => {
    const harness = createHarness();
    const room = joinPair(harness);
    const before = harness.service.getRoomState({ room_id: room.room_id });
    const codexBefore = before.members.find((m) => m.agent_id === "codex:test");
    expect(codexBefore).toBeDefined();

    harness.clock.advance(5_000);
    await harness.service.waitForEvents({
      agent_id: "codex:test",
      room_id: room.room_id,
      target_agent_id: "self",
      max_wait_ms: 0
    });

    const after = harness.service.getRoomState({ room_id: room.room_id });
    const codexAfter = after.members.find((m) => m.agent_id === "codex:test");
    // The sustained self-receiver is the documented presence primitive: it
    // refreshes last_seen_at so a watcher stays visible (issue #29 Defect 1)...
    expect(codexAfter?.last_seen_at).not.toBe(codexBefore?.last_seen_at);
    expect(Date.parse(codexAfter!.last_seen_at)).toBeGreaterThan(
      Date.parse(codexBefore!.last_seen_at)
    );
    // ...but watching is not turn-interest, so last_wait_at is untouched.
    expect(codexAfter?.last_wait_at).toBe(codexBefore?.last_wait_at);
  });

  test("waitForEvents target=any does not touch member presence", async () => {
    const harness = createHarness();
    const room = joinPair(harness);
    const before = harness.service.getRoomState({ room_id: room.room_id });
    const codexBefore = before.members.find((m) => m.agent_id === "codex:test");
    expect(codexBefore).toBeDefined();

    harness.clock.advance(5_000);
    await harness.service.waitForEvents({
      agent_id: "codex:test",
      room_id: room.room_id,
      target_agent_id: "any",
      max_wait_ms: 0
    });

    // An audit/debug target=any view is not participation: it must not refresh
    // presence (which would resurrect a stale peer into an active waiter).
    const after = harness.service.getRoomState({ room_id: room.room_id });
    const codexAfter = after.members.find((m) => m.agent_id === "codex:test");
    expect(codexAfter?.last_seen_at).toBe(codexBefore?.last_seen_at);
    expect(codexAfter?.last_wait_at).toBe(codexBefore?.last_wait_at);
  });

  test("waitForEvents on a closed room keeps the normal empty timeout shape", async () => {
    const harness = createHarness();
    const room = joinPair(harness);

    harness.service.db
      .prepare("UPDATE path_rooms SET state = 'closed' WHERE room_id = ?")
      .run(room.room_id);

    const result = await harness.service.waitForEvents({
      agent_id: "codex:test",
      room_id: room.room_id,
      target_agent_id: "self",
      max_wait_ms: 0
    });

    expect(result).toEqual({ events: [], cursor_event_seq: 0 });
  });

  test("waitForTurn include_events on a closed room still returns queued events", async () => {
    const harness = createHarness();
    const room = joinPair(harness);
    const message = harness.service.sendMessage({
      agent_id: "claude:test",
      room_id: room.room_id,
      to_agent_id: "codex:test",
      body: "final note before close"
    });
    harness.service.db
      .prepare("UPDATE path_rooms SET state = 'closed' WHERE room_id = ?")
      .run(room.room_id);

    const result = await harness.service.waitForTurn({
      agent_id: "codex:test",
      room_id: room.room_id,
      max_wait_ms: 0,
      include_events: true,
      after_event_seq: 0
    });

    expect(result.status).toBe("closed");
    expect(result.events?.map((event) => event.event_seq)).toEqual([
      message.event_seq
    ]);
    expect(result.cursor_event_seq).toBe(message.event_seq);
    expect(result.wake_reason).toBe("closed");
  });

  test("waitForTurn include_events grants the turn with queued events", async () => {
    const harness = createHarness();
    const room = joinPair(harness);

    harness.service.sendMessage({
      agent_id: "codex:test",
      room_id: room.room_id,
      to_agent_id: "claude:test",
      body: "claim with this context"
    });

    const result = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "claude:test",
        room_id: room.room_id,
        max_wait_ms: 0,
        include_events: true,
        after_event_seq: 0
      })
    );

    expect(result.reason).toBe("open_claim");
    expect(result.wake_reason).toBe("turn");
    expect(result.events?.map((event) => event.event_type)).toEqual([
      "message_sent",
      "claim"
    ]);
    expect(result.events?.[0].payload?.body).toBe("claim with this context");
    expect(result.cursor_event_seq).toBe(result.events?.[1].event_seq);
  });

  test("waitForTurn include_events lets the holder receive messages without mutating the lease", async () => {
    const harness = createHarness();
    const room = joinPair(harness);
    const codexTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: room.room_id,
        max_wait_ms: 0
      })
    );
    const afterClaim = harness.service.getLatestEventSeq({ room_id: room.room_id });
    const beforeLease = harness.service.listRooms({
      context_path: room.canonical_path
    }).rooms[0].lease_expires_at;

    harness.service.sendMessage({
      agent_id: "claude:test",
      room_id: room.room_id,
      to_agent_id: "codex:test",
      body: "still receiving?"
    });

    const result = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: room.room_id,
        max_wait_ms: 0,
        include_events: true,
        after_event_seq: afterClaim
      })
    );
    const afterLease = harness.service.listRooms({
      context_path: room.canonical_path
    }).rooms[0].lease_expires_at;

    expect(result.lease_id).toBe(codexTurn.lease_id);
    expect(result.reason).toBe("already_owner");
    expect(result.wake_reason).toBe("event");
    expect(messageBodies(result.events ?? [])).toEqual(["still receiving?"]);
    expect(result.cursor_event_seq).toBe(result.events?.[0].event_seq);
    expect(afterLease).toBe(beforeLease);
  });

  test("waitForTurn include_events holder timeout returns an owner checkpoint", async () => {
    const harness = createHarness();
    const room = joinPair(harness);
    const codexTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: room.room_id,
        max_wait_ms: 0
      })
    );
    const afterClaim = harness.service.getLatestEventSeq({ room_id: room.room_id });

    const result = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: room.room_id,
        max_wait_ms: 0,
        include_events: true,
        after_event_seq: afterClaim
      })
    );

    expect(result.lease_id).toBe(codexTurn.lease_id);
    expect(result.reason).toBe("already_owner");
    expect(result.events).toEqual([]);
    expect(result.cursor_event_seq).toBe(afterClaim);
    expect(result.wake_reason).toBe("timeout");
  });

  test("waitForTurn include_events alone does not preserve ownership after lease expiry", async () => {
    const harness = createHarness({
      policy: {
        ownerLeaseTtlMs: 1_000
      }
    });
    const room = joinPair(harness);
    const codexTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: room.room_id,
        max_wait_ms: 0
      })
    );
    const afterClaim = harness.service.getLatestEventSeq({ room_id: room.room_id });
    const beforeLease = harness.service.listRooms({
      context_path: room.canonical_path
    }).rooms[0].lease_expires_at;

    const checkpoint = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: room.room_id,
        max_wait_ms: 0,
        include_events: true,
        after_event_seq: afterClaim
      })
    );
    const afterCheckpointLease = harness.service.listRooms({
      context_path: room.canonical_path
    }).rooms[0].lease_expires_at;

    expect(checkpoint.lease_id).toBe(codexTurn.lease_id);
    expect(afterCheckpointLease).toBe(beforeLease);

    harness.clock.advance(1_001);

    const result = await harness.service.waitForTurn({
      agent_id: "claude:test",
      room_id: room.room_id,
      max_wait_ms: 0
    });

    expect(result.status).toBe("takeover_available");
    if (result.status !== "takeover_available") return;
    expect(result.reason).toBe("owner_timeout");
    expect(result.current_owner).toBe("codex:test");
  });

  test("waitForTurn include_events returns event-only wakes for non-owners", async () => {
    const harness = createHarness();
    const room = joinPair(harness);
    asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: room.room_id,
        max_wait_ms: 0
      })
    );
    const afterClaim = harness.service.getLatestEventSeq({ room_id: room.room_id });

    harness.service.sendMessage({
      agent_id: "codex:test",
      room_id: room.room_id,
      to_agent_id: "claude:test",
      body: "read while waiting"
    });

    const result = await harness.service.waitForTurn({
      agent_id: "claude:test",
      room_id: room.room_id,
      max_wait_ms: 0,
      include_events: true,
      after_event_seq: afterClaim
    });

    expect(result.status).toBe("not_yet");
    if (result.status !== "not_yet") return;
    expect(result.current_owner).toBe("codex:test");
    expect(result.wake_reason).toBe("event");
    expect(messageBodies(result.events ?? [])).toEqual(["read while waiting"]);
  });

  test("waitForTurn include_events reports lost_turn when a holder is taken over", async () => {
    const harness = createHarness();
    const room = joinPair(harness);
    const codexTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: room.room_id,
        max_wait_ms: 0
      })
    );
    const afterClaim = harness.service.getLatestEventSeq({ room_id: room.room_id });

    const waitPromise = harness.service.waitForTurn({
      agent_id: "codex:test",
      room_id: room.room_id,
      max_wait_ms: 50,
      include_events: true,
      after_event_seq: afterClaim
    });

    harness.service.takeoverStick({
      agent_id: "claude:test",
      room_id: room.room_id,
      expected_turn_id: codexTurn.turn_id,
      reason: "operator requested takeover",
      operator_override: true
    });

    const result = await waitPromise;

    expect(result.status).toBe("not_yet");
    if (result.status !== "not_yet") return;
    expect(result.reason).toBe("lost_turn");
    expect(result.current_owner).toBe("claude:test");
    expect(result.wake_reason).toBe("turn");
    expect(result.events?.map((event) => event.event_type)).toEqual([
      "takeover"
    ]);
  });

  test("waitForTurn include_events composes with park mode in idle rooms", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });
    const codexTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );
    harness.service.releaseStick({
      room_id: codexJoin.room_id,
      agent_id: "codex:test",
      lease_id: codexTurn.lease_id,
      expected_turn_id: codexTurn.turn_id,
      handoff: validHandoff()
    });
    const afterRelease = harness.service.getLatestEventSeq({
      room_id: codexJoin.room_id
    });
    harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project
    });
    harness.service.sendMessage({
      agent_id: "claude:test",
      room_id: codexJoin.room_id,
      to_agent_id: "codex:test",
      body: "park wake"
    });

    const result = await harness.service.waitForTurn({
      agent_id: "codex:test",
      room_id: codexJoin.room_id,
      max_wait_ms: 0,
      auto_claim: false,
      include_events: true,
      after_event_seq: afterRelease
    });

    expect(result.status).toBe("not_yet");
    if (result.status !== "not_yet") return;
    expect(result.reason).toBe("auto_claim_disabled");
    expect(result.wake_reason).toBe("turn");
    expect(messageBodies(result.events ?? [])).toEqual(["park wake"]);
  });

  test("waitForTurn include_events parked against an acknowledged handoff times out instead of turn-looping", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const join = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });
    const turn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: join.room_id,
        max_wait_ms: 0
      })
    );
    harness.service.releaseStick({
      room_id: join.room_id,
      agent_id: "codex:test",
      lease_id: turn.lease_id,
      expected_turn_id: turn.turn_id,
      handoff: validHandoff()
    });
    const afterRelease = harness.service.getLatestEventSeq({
      room_id: join.room_id
    });

    const firstPark = await harness.service.waitForTurn({
      agent_id: "codex:test",
      room_id: join.room_id,
      max_wait_ms: 0,
      auto_claim: false,
      include_events: true,
      after_event_seq: afterRelease
    });
    const secondPark = await harness.service.waitForTurn({
      agent_id: "codex:test",
      room_id: join.room_id,
      max_wait_ms: 0,
      auto_claim: false,
      include_events: true,
      after_event_seq: afterRelease
    });

    expect(firstPark.status).toBe("not_yet");
    if (firstPark.status !== "not_yet") return;
    expect(firstPark.reason).toBe("auto_claim_disabled");
    expect(firstPark.wake_reason).toBe("turn");

    expect(secondPark.status).toBe("not_yet");
    if (secondPark.status !== "not_yet") return;
    expect(secondPark.reason).toBeUndefined();
    expect(secondPark.wake_reason).toBe("timeout");
    expect(secondPark.events).toEqual([]);
  });

  test("waitForTurn include_events requires an explicit cursor", async () => {
    const harness = createHarness();
    const room = joinPair(harness);

    await expectProtocolError(
      harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: room.room_id,
        max_wait_ms: 0,
        include_events: true
      }),
      "invalid_cursor"
    );
  });

  test("message events preserve monotonic order when interleaved with release", async () => {
    const harness = createHarness();
    const room = joinPair(harness);

    const message = harness.service.sendMessage({
      agent_id: "codex:test",
      room_id: room.room_id,
      to_agent_id: "claude:test",
      body: "before release"
    });
    const turn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: room.room_id,
        max_wait_ms: 0
      })
    );
    const release = harness.service.releaseStick({
      room_id: room.room_id,
      agent_id: "codex:test",
      lease_id: turn.lease_id,
      expected_turn_id: turn.turn_id,
      handoff: validHandoff()
    });

    expect(message.event_seq).toBeLessThan(release.event_seq);
    expect(
      harness.service
        .getRoomEvents({ room_id: room.room_id })
        .map((event) => event.event_type)
    ).toEqual(["message_sent", "claim", "release"]);
  });

  test("concurrent sendMessage calls get distinct event sequences", async () => {
    const harness = createHarness();
    const room = joinPair(harness);

    const [left, right] = await Promise.all([
      Promise.resolve().then(() =>
        harness.service.sendMessage({
          agent_id: "codex:test",
          room_id: room.room_id,
          to_agent_id: "claude:test",
          body: "left"
        })
      ),
      Promise.resolve().then(() =>
        harness.service.sendMessage({
          agent_id: "claude:test",
          room_id: room.room_id,
          to_agent_id: "codex:test",
          body: "right"
        })
      )
    ]);

    expect(left.event_seq).not.toBe(right.event_seq);
    expect(new Set([left.event_id, right.event_id]).size).toBe(2);
  });
});

function createHarness(options: { policy?: Partial<Policy> } = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-oob-"));
  tempRoots.push(tempRoot);

  const clock = fakeClock();
  const dbPath = path.join(tempRoot, "state", "rooms.sqlite");
  const service = new TalkingStickService({
    dbPath,
    now: clock.now,
    policy: {
      ...options.policy,
      waitForEventsMaxWaitMs: 5,
      waitForEventsPollMs: 1
    }
  });
  services.push(service);

  return { tempRoot, clock, service };
}

function createProject(tempRoot: string): string {
  const project = path.join(tempRoot, "project");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "package.json"), "{}\n");
  return fs.realpathSync.native(project);
}

function joinPair(harness: ReturnType<typeof createHarness>) {
  const project = createProject(harness.tempRoot);
  const room = harness.service.joinPath({
    agent_id: "codex:test",
    context_path: project
  });
  harness.service.joinPath({
    agent_id: "claude:test",
    context_path: project
  });
  return room;
}

function joinTrio(harness: ReturnType<typeof createHarness>) {
  const room = joinPair(harness);
  harness.service.joinPath({
    agent_id: "gemini:test",
    context_path: room.canonical_path
  });
  return room;
}

function fakeClock(startMs = Date.UTC(2026, 3, 22, 12, 0, 0)) {
  let currentMs = startMs;

  return {
    now: () => new Date(currentMs),
    advance: (ms: number) => {
      currentMs += ms;
    }
  };
}

function validHandoff(): Handoff {
  return {
    status: "Finished the current step.",
    next_action: "Continue with the next step."
  };
}

function asYourTurn(result: WaitForTurnResult) {
  expect(result.status).toBe("your_turn");
  if (result.status !== "your_turn") {
    throw new Error(`Expected your_turn, got ${result.status}`);
  }
  return result;
}

function messageBodies(events: RoomEvent[]): string[] {
  return events.map((event) => event.payload?.body ?? "");
}

async function expectProtocolError(
  promise: Promise<unknown>,
  expectedCode: string
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe(expectedCode);
    return;
  }

  throw new Error(`Expected ProtocolError ${expectedCode}`);
}

expect.extend({
  toThrowProtocolError(received: () => unknown, expectedCode: string) {
    try {
      received();
    } catch (error) {
      const pass =
        error instanceof ProtocolError && error.code === expectedCode;
      return {
        pass,
        message: () =>
          pass
            ? `expected function not to throw ${expectedCode}`
            : `expected ProtocolError ${expectedCode}, got ${
                error instanceof ProtocolError
                  ? error.code
                  : String(error)
              }`
      };
    }

    return {
      pass: false,
      message: () => `expected function to throw ${expectedCode}`
    };
  }
});
