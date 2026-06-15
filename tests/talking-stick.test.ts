import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  ProtocolError,
  TalkingStickService,
  type Handoff,
  type Policy,
  type ProcessLiveness,
  type ProcessMetadata,
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

describe("talking-stick vertical slice", () => {
  test("join_path -> wait_for_turn open claim -> release_stick handoff -> second agent claims", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const nestedPath = path.join(project, "src", "feature");
    fs.mkdirSync(nestedPath, { recursive: true });

    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });
    const claudeJoin = harness.service.joinPath({
      agent_id: "claude:test",
      context_path: nestedPath
    });

    expect(claudeJoin.room_id).toBe(codexJoin.room_id);

    const codexTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );

    const handoff: Handoff = {
      status: "Implemented the first slice through release.",
      next_action: "Claim the reserved turn and verify the handoff.",
      artifacts: [
        {
          path: "src/service.ts",
          role: "review",
          note: "Check release sequencing."
        }
      ]
    };

    const release = harness.service.releaseStick({
      room_id: codexJoin.room_id,
      agent_id: "codex:test",
      lease_id: codexTurn.lease_id,
      expected_turn_id: codexTurn.turn_id,
      handoff
    });

    expect(release.reserved_for).toBe("claude:test");

    const claudeTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "claude:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );

    expect(claudeTurn.reason).toBe("sequence");
    expect(claudeTurn.from_agent_id).toBe("codex:test");
    expect(claudeTurn.handoff).toEqual(handoff);
    expect(claudeTurn.turn_id).toBe(codexTurn.turn_id + 1);
  });

  test("join_path and get_room_state expose the current event cursor", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);

    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });
    expect(codexJoin.cursor_event_seq).toBe(0);

    const codexTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );

    const stateAfterClaim = harness.service.getRoomState({
      room_id: codexJoin.room_id,
      agent_id: "codex:test"
    });
    expect(stateAfterClaim.cursor_event_seq).toBe(1);

    harness.service.releaseStick({
      room_id: codexJoin.room_id,
      agent_id: "codex:test",
      lease_id: codexTurn.lease_id,
      expected_turn_id: codexTurn.turn_id,
      handoff: validHandoff()
    });

    const claudeJoin = harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project
    });
    expect(claudeJoin.cursor_event_seq).toBe(2);
  });

  test("release_stick prefers a new waiter over the next join-order member", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);

    const agentOne = harness.service.joinPath({
      agent_id: "agent:one",
      context_path: project
    });
    harness.service.joinPath({
      agent_id: "agent:three",
      context_path: project
    });
    harness.service.joinPath({
      agent_id: "agent:two",
      context_path: project
    });

    const firstTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "agent:one",
        room_id: agentOne.room_id,
        max_wait_ms: 0
      })
    );

    harness.service.passStick({
      room_id: agentOne.room_id,
      agent_id: "agent:one",
      lease_id: firstTurn.lease_id,
      expected_turn_id: firstTurn.turn_id,
      to_agent_id: "agent:two",
      handoff: validHandoff()
    });

    const secondTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "agent:two",
        room_id: agentOne.room_id,
        max_wait_ms: 0
      })
    );

    const release = harness.service.releaseStick({
      room_id: agentOne.room_id,
      agent_id: "agent:two",
      lease_id: secondTurn.lease_id,
      expected_turn_id: secondTurn.turn_id,
      handoff: validHandoff()
    });

    expect(release.reserved_for).toBe("agent:three");
  });

  test("fair turn ordering uses current ordinal rank after member churn", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const joins = Array.from({ length: 8 }, (_, index) =>
      harness.service.joinPath({
        agent_id: `agent:${index}`,
        context_path: project
      })
    );

    for (const index of [1, 2, 3, 4, 6]) {
      harness.service.leaveRoom({
        agent_id: `agent:${index}`,
        room_id: joins[0].room_id
      });
    }

    const firstTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "agent:0",
        room_id: joins[0].room_id,
        max_wait_ms: 0
      })
    );

    for (const agentId of ["agent:5", "agent:7"]) {
      const wait = await harness.service.waitForTurn({
        agent_id: agentId,
        room_id: joins[0].room_id,
        max_wait_ms: 0
      });
      expect(wait.status).toBe("not_yet");
    }

    const release = harness.service.releaseStick({
      room_id: joins[0].room_id,
      agent_id: "agent:0",
      lease_id: firstTurn.lease_id,
      expected_turn_id: firstTurn.turn_id,
      handoff: validHandoff()
    });

    expect(release.reserved_for).toBe("agent:5");
  });

  test("idle handoff briefly defers a less-fair claimant for a stale best candidate", async () => {
    const harness = createHarness({
      policy: {
        waiterGraceMs: 10_000
      }
    });
    const project = createProject(harness.tempRoot);

    const agentOne = harness.service.joinPath({
      agent_id: "agent:one",
      context_path: project
    });
    harness.service.joinPath({
      agent_id: "agent:three",
      context_path: project
    });
    harness.service.joinPath({
      agent_id: "agent:two",
      context_path: project
    });

    const firstTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "agent:one",
        room_id: agentOne.room_id,
        max_wait_ms: 0
      })
    );

    harness.service.passStick({
      room_id: agentOne.room_id,
      agent_id: "agent:one",
      lease_id: firstTurn.lease_id,
      expected_turn_id: firstTurn.turn_id,
      to_agent_id: "agent:two",
      handoff: validHandoff()
    });

    const secondTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "agent:two",
        room_id: agentOne.room_id,
        max_wait_ms: 0
      })
    );

    harness.clock.advance(10_001);

    const release = harness.service.releaseStick({
      room_id: agentOne.room_id,
      agent_id: "agent:two",
      lease_id: secondTurn.lease_id,
      expected_turn_id: secondTurn.turn_id,
      handoff: validHandoff()
    });

    expect(release.reserved_for).toBeNull();

    const earlyClaim = await harness.service.waitForTurn({
      agent_id: "agent:one",
      room_id: agentOne.room_id,
      max_wait_ms: 0
    });
    expect(earlyClaim.status).toBe("not_yet");

    const fairClaim = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "agent:three",
        room_id: agentOne.room_id,
        max_wait_ms: 0
      })
    );
    expect(fairClaim.reason).toBe("sequence");
  });

  test("idle handoff defers the prior owner for release cooldown while another active member exists", async () => {
    const harness = createHarness({
      policy: {
        waiterGraceMs: 10_000
      }
    });
    const project = createProject(harness.tempRoot);

    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });
    harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project
    });

    const codexTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );

    harness.clock.advance(10_001);

    const release = harness.service.releaseStick({
      room_id: codexJoin.room_id,
      agent_id: "codex:test",
      lease_id: codexTurn.lease_id,
      expected_turn_id: codexTurn.turn_id,
      handoff: validHandoff()
    });

    expect(release.reserved_for).toBeNull();

    const immediateTakeBack = await harness.service.waitForTurn({
      agent_id: "codex:test",
      room_id: codexJoin.room_id,
      max_wait_ms: 0
    });
    expect(immediateTakeBack.status).toBe("not_yet");

    const claudeTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "claude:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );
    expect(claudeTurn.reason).toBe("sequence");
  });

  test("idle handoff allows the prior owner after release cooldown if no other member claims", async () => {
    const harness = createHarness({
      policy: {
        waiterGraceMs: 10_000
      }
    });
    const project = createProject(harness.tempRoot);

    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });
    harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project
    });

    const codexTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );

    harness.clock.advance(10_001);

    harness.service.releaseStick({
      room_id: codexJoin.room_id,
      agent_id: "codex:test",
      lease_id: codexTurn.lease_id,
      expected_turn_id: codexTurn.turn_id,
      handoff: validHandoff()
    });

    harness.clock.advance(60_001);

    const codexAgain = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );
    expect(codexAgain.reason).toBe("sequence");
  });

  test("idle handoff allows the prior owner immediately when solo", async () => {
    const harness = createHarness({
      policy: {
        waiterGraceMs: 10_000
      }
    });
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

    const release = harness.service.releaseStick({
      room_id: codexJoin.room_id,
      agent_id: "codex:test",
      lease_id: codexTurn.lease_id,
      expected_turn_id: codexTurn.turn_id,
      handoff: validHandoff()
    });

    expect(release.reserved_for).toBeNull();

    const codexAgain = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );
    expect(codexAgain.reason).toBe("sequence");
  });

  test("target-any event waits do not make a stale peer block prior owner reclaim", async () => {
    const harness = createHarness({
      policy: {
        presenceTtlMs: 1_000,
        waiterGraceMs: 10_000
      }
    });
    const project = createProject(harness.tempRoot);

    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });
    harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project
    });

    const codexTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );

    harness.clock.advance(1_001);

    await harness.service.waitForEvents({
      agent_id: "claude:test",
      room_id: codexJoin.room_id,
      target_agent_id: "any",
      max_wait_ms: 0
    });

    harness.service.releaseStick({
      room_id: codexJoin.room_id,
      agent_id: "codex:test",
      lease_id: codexTurn.lease_id,
      expected_turn_id: codexTurn.turn_id,
      handoff: validHandoff()
    });

    const codexAgain = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );
    expect(codexAgain.reason).toBe("sequence");
  });

  test("operator override can take a live owned turn explicitly", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);

    const join = harness.service.joinPath({
      agent_id: "agent:owner",
      context_path: project
    });
    harness.service.joinPath({
      agent_id: "human:operator",
      context_path: project,
      process_metadata: { session_kind: "human_cli", display_name: "operator" }
    });

    const ownerTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "agent:owner",
        room_id: join.room_id,
        max_wait_ms: 0
      })
    );

    expect(() =>
      harness.service.takeoverStick({
        agent_id: "human:operator",
        room_id: join.room_id,
        expected_turn_id: ownerTurn.turn_id,
        reason: "operator wants control"
      })
    ).toThrowProtocolError("takeover_not_available");

    const operatorTurn = harness.service.takeoverStick({
      agent_id: "human:operator",
      room_id: join.room_id,
      expected_turn_id: ownerTurn.turn_id,
      reason: "operator wants control",
      operator_override: true
    });

    expect(operatorTurn.reason).toBe("operator_override");
    expect(operatorTurn.revoked_agent_id).toBe("agent:owner");
  });

  test("release_stick rejects an empty handoff", async () => {
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

    expect(() =>
      harness.service.releaseStick({
        room_id: join.room_id,
        agent_id: "codex:test",
        lease_id: turn.lease_id,
        expected_turn_id: turn.turn_id,
        handoff: { status: "", next_action: "review" }
      })
    ).toThrowProtocolError("invalid_handoff");
  });

  test("owner mutations reject a stale lease", async () => {
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

    expect(() =>
      harness.service.releaseStick({
        room_id: join.room_id,
        agent_id: "codex:test",
        lease_id: "not-the-current-lease",
        expected_turn_id: turn.turn_id,
        handoff: validHandoff()
      })
    ).toThrowProtocolError("stale_lease");
  });

  test("owner mutations reject a turn mismatch", async () => {
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

    expect(() =>
      harness.service.releaseStick({
        room_id: join.room_id,
        agent_id: "codex:test",
        lease_id: turn.lease_id,
        expected_turn_id: turn.turn_id + 1,
        handoff: validHandoff()
      })
    ).toThrowProtocolError("turn_mismatch");
  });

  test("join_path uses the deepest existing ancestor room", () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const nestedPath = path.join(project, "packages", "api", "src");
    fs.mkdirSync(nestedPath, { recursive: true });

    const rootJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });
    const nestedJoin = harness.service.joinPath({
      agent_id: "claude:test",
      context_path: nestedPath
    });

    expect(nestedJoin.room_id).toBe(rootJoin.room_id);
    expect(nestedJoin.canonical_path).toBe(project);
  });

  test("join_path creates a room at the resolved workspace root", () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const nestedPath = path.join(project, "packages", "api", "src");
    fs.mkdirSync(nestedPath, { recursive: true });

    const join = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: nestedPath
    });

    expect(join.canonical_path).toBe(project);
  });

  test("join_path with force_new creates a nested room when an ancestor room exists", () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const nestedPath = path.join(project, "packages", "topic-a");
    fs.mkdirSync(nestedPath, { recursive: true });

    const rootJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });
    const nestedJoin = harness.service.joinPath({
      agent_id: "claude:test",
      context_path: nestedPath,
      force_new: true
    });

    expect(nestedJoin.room_id).not.toBe(rootJoin.room_id);
    expect(nestedJoin.canonical_path).toBe(nestedPath);
    expect(nestedJoin.joined_existing_room).toBe(false);
    expect(nestedJoin.warning).toContain("Created nested room inside");
  });

  test("join_path with force_new is a no-op when an exact-path room already exists, and surfaces a warning", () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);

    const firstJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });
    expect(firstJoin.warning).toBeUndefined();

    const secondJoin = harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project,
      force_new: true
    });

    expect(secondJoin.room_id).toBe(firstJoin.room_id);
    expect(secondJoin.joined_existing_room).toBe(true);
    expect(secondJoin.warning).toBeDefined();
    expect(secondJoin.warning).toContain("force_new had no effect");
    expect(harness.service.listRooms({ context_path: project }).rooms).toHaveLength(1);
  });

  test("leave_room removes a member and deletes the room when it was last", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);

    const join = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });
    await harness.service.waitForTurn({
      agent_id: "codex:test",
      room_id: join.room_id,
      max_wait_ms: 0
    });

    const result = harness.service.leaveRoom({
      agent_id: "codex:test",
      room_id: join.room_id
    });

    expect(result).toEqual({
      status: "room_deleted",
      room_id: join.room_id,
      canonical_path: project,
      remaining_members: 0
    });
    expect(harness.service.listRooms({ context_path: project }).rooms).toEqual([]);
    expect(() =>
      harness.service.getRoomState({ room_id: join.room_id })
    ).toThrowProtocolError("room_not_found");
    expect(countRows(harness.service, "path_rooms")).toBe(0);
    expect(countRows(harness.service, "room_members")).toBe(0);
    expect(countRows(harness.service, "room_events")).toBe(0);
  });

  test("leave_room clears a departed reserved recipient without dropping the handoff", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);

    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });
    harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project
    });

    const codexTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );
    const handoff = validHandoff();
    harness.service.releaseStick({
      room_id: codexJoin.room_id,
      agent_id: "codex:test",
      lease_id: codexTurn.lease_id,
      expected_turn_id: codexTurn.turn_id,
      handoff
    });

    const result = harness.service.leaveRoom({
      agent_id: "claude:test",
      room_id: codexJoin.room_id
    });
    expect(result.status).toBe("left");
    expect(result.remaining_members).toBe(1);

    const state = harness.service.getRoomState({
      room_id: codexJoin.room_id,
      agent_id: "codex:test"
    });
    expect(state.room.state).toBe("idle");
    expect(state.room.reserved_for).toBeNull();
    expect(state.members.map((member) => member.agent_id)).toEqual([
      "codex:test"
    ]);

    const nextTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );
    expect(nextTurn.handoff).toEqual(handoff);
  });

  test("leave_room deletes the room when only inactive members remain", () => {
    const harness = createHarness({
      policy: {
        presenceTtlMs: 500
      }
    });
    const project = createProject(harness.tempRoot);

    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });
    harness.service.joinPath({
      agent_id: "claude:stale",
      context_path: project
    });

    harness.clock.advance(501);

    const result = harness.service.leaveRoom({
      agent_id: "codex:test",
      room_id: codexJoin.room_id
    });

    expect(result.status).toBe("room_deleted");
    expect(harness.service.listRooms({ context_path: project }).rooms).toEqual([]);
  });

  test("long-idle rooms are purged opportunistically when the service is invoked", () => {
    const harness = createHarness({
      policy: {
        idleRoomTtlMs: 1_000,
        presenceTtlMs: 500
      }
    });
    const project = createProject(harness.tempRoot);

    const join = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });

    harness.clock.advance(1_001);

    expect(harness.service.listRooms({ context_path: project }).rooms).toEqual([]);
    expect(countRows(harness.service, "path_rooms")).toBe(0);
    expect(countRows(harness.service, "room_members")).toBe(0);
    expect(() =>
      harness.service.getRoomState({ room_id: join.room_id })
    ).toThrowProtocolError("room_not_found");
  });

  test("long-idle rooms are retained while a recorded member process is alive", () => {
    const harness = createHarness({
      policy: {
        idleRoomTtlMs: 1_000,
        presenceTtlMs: 500
      }
    });
    const project = createProject(harness.tempRoot);
    const codexProcess = harness.processRegistry.create("codex");

    const join = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project,
      process_metadata: codexProcess
    });

    harness.clock.advance(1_001);

    const retainedRooms = harness.service.listRooms({ context_path: project });
    expect(retainedRooms.rooms).toHaveLength(1);
    expect(retainedRooms.rooms[0]?.room_id).toBe(join.room_id);
    expect(countRows(harness.service, "path_rooms")).toBe(1);

    harness.processRegistry.markGone(codexProcess);

    expect(harness.service.listRooms({ context_path: project }).rooms).toEqual([]);
    expect(countRows(harness.service, "path_rooms")).toBe(0);
    expect(countRows(harness.service, "room_members")).toBe(0);
  });

  test("join_path returns the effective policy including heartbeat cadence", () => {
    const harness = createHarness({
      policy: {
        ownerLeaseTtlMs: 50_000,
        heartbeatIntervalMs: 12_000,
        claimTtlMs: 30_000
      }
    });
    const project = createProject(harness.tempRoot);

    const join = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });

    expect(join.policy).toMatchObject({
      ownerLeaseTtlMs: 50_000,
      heartbeatIntervalMs: 12_000,
      claimTtlMs: 30_000,
      waitForTurnMaxWaitMs: 110_000,
      waitForTurnPollMs: 250,
      waitForEventsMaxWaitMs: 110_000
    });
  });

  test("claim-timeout takeover rejects the prior owner while another member is active", async () => {
    const harness = createHarness({
      policy: {
        claimTtlMs: 1_000,
        presenceTtlMs: 60_000
      }
    });
    const project = createProject(harness.tempRoot);

    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });
    harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project
    });
    harness.service.joinPath({
      agent_id: "gemini:test",
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

    harness.clock.advance(1_001);

    expect(() =>
      harness.service.takeoverStick({
        agent_id: "codex:test",
        room_id: codexJoin.room_id,
        expected_turn_id: codexTurn.turn_id,
        reason: "claim timeout expired"
      })
    ).toThrowProtocolError("takeover_ineligible");

    const geminiTurn = harness.service.takeoverStick({
      agent_id: "gemini:test",
      room_id: codexJoin.room_id,
      expected_turn_id: codexTurn.turn_id,
      reason: "claim timeout expired"
    });

    expect(geminiTurn.status).toBe("your_turn");
    expect(geminiTurn.reason).toBe("claim_timeout");
    expect(geminiTurn.revoked_agent_id).toBe("claude:test");
  });

  test("wait_for_turn returns takeover_available after claim timeout for another active member", async () => {
    const harness = createHarness({
      policy: {
        claimTtlMs: 1_000,
        presenceTtlMs: 60_000
      }
    });
    const project = createProject(harness.tempRoot);

    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });
    harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project
    });
    harness.service.joinPath({
      agent_id: "gemini:test",
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

    harness.clock.advance(1_001);

    const result = await harness.service.waitForTurn({
      agent_id: "gemini:test",
      room_id: codexJoin.room_id,
      max_wait_ms: 0
    });

    expect(result).toEqual({
      status: "takeover_available",
      room_id: codexJoin.room_id,
      turn_id: codexTurn.turn_id,
      room_state: "reserved",
      reason: "claim_timeout",
      reserved_for: "claude:test"
    });
  });

  test("reserved recipient may still claim after claim timeout until takeover commits", async () => {
    const harness = createHarness({
      policy: {
        claimTtlMs: 1_000
      }
    });
    const project = createProject(harness.tempRoot);

    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });
    harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project
    });

    const codexTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );

    const handoff = validHandoff();
    harness.service.releaseStick({
      room_id: codexJoin.room_id,
      agent_id: "codex:test",
      lease_id: codexTurn.lease_id,
      expected_turn_id: codexTurn.turn_id,
      handoff
    });

    harness.clock.advance(1_001);

    const claudeTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "claude:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );

    expect(claudeTurn.reason).toBe("sequence");
    expect(claudeTurn.from_agent_id).toBe("codex:test");
    expect(claudeTurn.handoff).toEqual(handoff);
    expect(claudeTurn.turn_id).toBe(codexTurn.turn_id + 1);
  });

  test("wait_for_turn returns takeover_available after owner lease timeout", async () => {
    const harness = createHarness({
      policy: {
        ownerLeaseTtlMs: 1_000
      }
    });
    const project = createProject(harness.tempRoot);

    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });
    harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project
    });

    const codexTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );

    harness.clock.advance(1_001);

    const result = await harness.service.waitForTurn({
      agent_id: "claude:test",
      room_id: codexJoin.room_id,
      max_wait_ms: 0
    });

    expect(result).toEqual({
      status: "takeover_available",
      room_id: codexJoin.room_id,
      turn_id: codexTurn.turn_id,
      room_state: "stale_owner",
      reason: "owner_timeout",
      current_owner: "codex:test"
    });
  });

  test("expired owner may heartbeat before takeover commits", async () => {
    const harness = createHarness({
      policy: {
        ownerLeaseTtlMs: 1_000
      }
    });
    const project = createProject(harness.tempRoot);

    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });
    harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project
    });

    const codexTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );

    harness.clock.advance(1_001);

    const heartbeat = harness.service.heartbeat({
      room_id: codexJoin.room_id,
      agent_id: "codex:test",
      lease_id: codexTurn.lease_id,
      expected_turn_id: codexTurn.turn_id
    });

    expect(heartbeat.status).toBe("ok");
    expect(Date.parse(heartbeat.lease_expires_at)).toBeGreaterThan(
      harness.clock.now().getTime()
    );

    const state = harness.service.getRoomState({ room_id: codexJoin.room_id });
    expect(state.room.state).toBe("owned");
    expect(state.room.owner).toBe("codex:test");

    const claudeResult = await harness.service.waitForTurn({
      agent_id: "claude:test",
      room_id: codexJoin.room_id,
      max_wait_ms: 0
    });
    expect(claudeResult.status).toBe("not_yet");
  });

  test("takeover succeeds after owner lease timeout and fences stale owner writes", async () => {
    const harness = createHarness({
      policy: {
        ownerLeaseTtlMs: 1_000
      }
    });
    const project = createProject(harness.tempRoot);

    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });
    harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project
    });

    const codexTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );

    harness.clock.advance(1_001);

    const availability = await harness.service.waitForTurn({
      agent_id: "claude:test",
      room_id: codexJoin.room_id,
      max_wait_ms: 0
    });
    expect(availability.status).toBe("takeover_available");

    const claudeTurn = harness.service.takeoverStick({
      agent_id: "claude:test",
      room_id: codexJoin.room_id,
      expected_turn_id: codexTurn.turn_id,
      reason: "owner lease expired"
    });

    expect(claudeTurn.status).toBe("your_turn");
    expect(claudeTurn.reason).toBe("owner_timeout");
    expect(claudeTurn.revoked_agent_id).toBe("codex:test");
    expect(claudeTurn.turn_id).toBe(codexTurn.turn_id + 1);

    expect(() =>
      harness.service.heartbeat({
        room_id: codexJoin.room_id,
        agent_id: "codex:test",
        lease_id: codexTurn.lease_id,
        expected_turn_id: codexTurn.turn_id
      })
    ).toThrowProtocolError("turn_mismatch");
  });

  test("owner_gone waits for the silence grace window before opening takeover", async () => {
    const harness = createHarness({
      policy: {
        heartbeatIntervalMs: 1_000
      }
    });
    const project = createProject(harness.tempRoot);
    const codexProcess = harness.processRegistry.create("codex");
    const claudeProcess = harness.processRegistry.create("claude");

    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project,
      process_metadata: codexProcess
    });
    harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project,
      process_metadata: claudeProcess
    });

    const codexTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );

    harness.processRegistry.markGone(codexProcess);

    const immediateState = harness.service.getRoomState({
      room_id: codexJoin.room_id
    });
    expect(immediateState.room.state).toBe("owned");

    const claudeBeforeGrace = await harness.service.waitForTurn({
      agent_id: "claude:test",
      room_id: codexJoin.room_id,
      max_wait_ms: 0
    });
    expect(claudeBeforeGrace.status).toBe("not_yet");
    if (claudeBeforeGrace.status === "not_yet") {
      expect(claudeBeforeGrace.room_state).toBe("owned");
    }

    harness.clock.advance(2_001);

    const state = harness.service.getRoomState({ room_id: codexJoin.room_id });
    expect(state.room.state).toBe("owner_gone");

    const claudeView = await harness.service.waitForTurn({
      agent_id: "claude:test",
      room_id: codexJoin.room_id,
      max_wait_ms: 0
    });
    expect(claudeView).toEqual({
      status: "takeover_available",
      room_id: codexJoin.room_id,
      turn_id: codexTurn.turn_id,
      room_state: "owner_gone",
      reason: "owner_gone",
      current_owner: "codex:test"
    });

    expect(() =>
      harness.service.heartbeat({
        room_id: codexJoin.room_id,
        agent_id: "codex:test",
        lease_id: codexTurn.lease_id,
        expected_turn_id: codexTurn.turn_id
      })
    ).toThrowProtocolError("stale_lease");
  });

  test("room-scoped reads refresh owner presence and defer owner_gone", async () => {
    const harness = createHarness({
      policy: {
        heartbeatIntervalMs: 1_000
      }
    });
    const project = createProject(harness.tempRoot);
    const codexProcess = harness.processRegistry.create("codex");
    const claudeProcess = harness.processRegistry.create("claude");

    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project,
      process_metadata: codexProcess
    });
    harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project,
      process_metadata: claudeProcess
    });

    asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );

    harness.processRegistry.markGone(codexProcess);
    harness.clock.advance(1_500);

    const firstReadAt = harness.clock.now().toISOString();
    const ownerState = harness.service.getRoomState({
      room_id: codexJoin.room_id,
      agent_id: "codex:test"
    });
    expect(ownerState.room.state).toBe("owned");
    expect(
      ownerState.members.find((member) => member.agent_id === "codex:test")
        ?.last_seen_at
    ).toBe(firstReadAt);

    harness.clock.advance(1_500);

    const secondReadAt = harness.clock.now().toISOString();
    const ownerEvents = harness.service.getRoomEvents({
      room_id: codexJoin.room_id,
      agent_id: "codex:test"
    });
    expect(ownerEvents).toHaveLength(1);

    const viewerState = harness.service.getRoomState({ room_id: codexJoin.room_id });
    expect(viewerState.room.state).toBe("owned");
    expect(
      viewerState.members.find((member) => member.agent_id === "codex:test")
        ?.last_seen_at
    ).toBe(secondReadAt);

    harness.clock.advance(2_001);

    const expiredState = harness.service.getRoomState({
      room_id: codexJoin.room_id
    });
    expect(expiredState.room.state).toBe("owner_gone");
  });

  test("room-scoped reads with non-member agent_id are harmless no-ops", () => {
    // Locks down the touchKnownMember defensive path: a read call from an
    // agent_id that is not a room member must still return the projection but
    // must NOT create, touch, or otherwise mutate member state. Prevents a
    // typo or stale identity from silently conjuring ghost members.
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const ownerProcess = harness.processRegistry.create("codex");

    const join = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project,
      process_metadata: ownerProcess
    });

    const stateRead = harness.service.getRoomState({
      room_id: join.room_id,
      agent_id: "stranger:nobody"
    });
    expect(stateRead.room.room_id).toBe(join.room_id);

    const eventsRead = harness.service.getRoomEvents({
      room_id: join.room_id,
      agent_id: "stranger:nobody"
    });
    expect(Array.isArray(eventsRead)).toBe(true);

    const membershipAfter = harness.service.getRoomState({
      room_id: join.room_id
    });
    const ids = membershipAfter.members.map((m) => m.agent_id);
    expect(ids).toContain("codex:test");
    expect(ids).not.toContain("stranger:nobody");
  });

  test("one-shot human joins do not displace guardian owner liveness", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const guardianProcess = harness.processRegistry.create(
      "alice",
      "human_guardian"
    );
    const transientCliProcess = harness.processRegistry.create(
      "alice",
      "human_cli"
    );

    const humanJoin = harness.service.joinPath({
      agent_id: "human:alice",
      context_path: project,
      process_metadata: guardianProcess
    });

    const humanTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "human:alice",
        room_id: humanJoin.room_id,
        max_wait_ms: 0
      })
    );

    harness.service.joinPath({
      agent_id: "human:alice",
      context_path: project,
      process_metadata: transientCliProcess
    });
    harness.processRegistry.markGone(transientCliProcess);

    const state = harness.service.getRoomState({ room_id: humanJoin.room_id });
    expect(state.room.state).toBe("owned");

    const heartbeat = harness.service.heartbeat({
      room_id: humanJoin.room_id,
      agent_id: "human:alice",
      lease_id: humanTurn.lease_id,
      expected_turn_id: humanTurn.turn_id
    });
    expect(heartbeat.status).toBe("ok");
  });

  test("release sequence does not probe exact liveness for every member", async () => {
    let livenessChecks = 0;
    const harness = createHarness({
      processLivenessChecker: () => {
        livenessChecks += 1;
        return "alive";
      }
    });
    const project = createProject(harness.tempRoot);

    const ownerMetadata = harness.processRegistry.create("codex");
    const join = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project,
      process_metadata: ownerMetadata
    });

    for (let index = 0; index < 10; index += 1) {
      harness.service.joinPath({
        agent_id: `agent-${index}`,
        context_path: project,
        process_metadata: harness.processRegistry.create(`agent-${index}`)
      });
    }

    const turn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: join.room_id,
        max_wait_ms: 0
      })
    );

    livenessChecks = 0;
    harness.service.releaseStick({
      room_id: join.room_id,
      agent_id: "codex:test",
      lease_id: turn.lease_id,
      expected_turn_id: turn.turn_id,
      handoff: validHandoff()
    });

    expect(livenessChecks).toBeLessThanOrEqual(2);
  });

  test("list_rooms summaries do not probe exact process liveness", async () => {
    let livenessChecks = 0;
    const harness = createHarness({
      processLivenessChecker: () => {
        livenessChecks += 1;
        return "alive";
      }
    });
    const firstProject = createProject(harness.tempRoot);
    const secondProject = path.join(harness.tempRoot, "project-b");
    fs.mkdirSync(secondProject, { recursive: true });
    fs.writeFileSync(path.join(secondProject, "package.json"), "{}\n");

    const firstJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: firstProject,
      process_metadata: harness.processRegistry.create("codex")
    });
    const secondJoin = harness.service.joinPath({
      agent_id: "claude:test",
      context_path: secondProject,
      process_metadata: harness.processRegistry.create("claude")
    });
    harness.service.joinPath({
      agent_id: "gemini:test",
      context_path: secondProject,
      process_metadata: harness.processRegistry.create("gemini")
    });

    asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: firstJoin.room_id,
        max_wait_ms: 0
      })
    );
    const secondTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "claude:test",
        room_id: secondJoin.room_id,
        max_wait_ms: 0
      })
    );

    harness.service.releaseStick({
      room_id: secondJoin.room_id,
      agent_id: "claude:test",
      lease_id: secondTurn.lease_id,
      expected_turn_id: secondTurn.turn_id,
      handoff: validHandoff()
    });

    livenessChecks = 0;
    const rooms = harness.service.listRooms();

    expect(rooms.rooms).toHaveLength(2);
    expect(rooms.rooms.map((room) => room.state).sort()).toEqual([
      "owned",
      "reserved"
    ]);
    expect(livenessChecks).toBe(0);
  });

  test("recipient_gone becomes diagnostic only after claim timeout and gone grace expire", async () => {
    const harness = createHarness({
      policy: {
        heartbeatIntervalMs: 1_000,
        claimTtlMs: 1_000
      }
    });
    const project = createProject(harness.tempRoot);
    const codexProcess = harness.processRegistry.create("codex");
    const claudeProcess = harness.processRegistry.create("claude");
    const geminiProcess = harness.processRegistry.create("gemini");

    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project,
      process_metadata: codexProcess
    });
    harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project,
      process_metadata: claudeProcess
    });
    harness.service.joinPath({
      agent_id: "gemini:test",
      context_path: project,
      process_metadata: geminiProcess
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

    harness.processRegistry.markGone(claudeProcess);

    const immediateState = harness.service.getRoomState({
      room_id: codexJoin.room_id
    });
    expect(immediateState.room.state).toBe("reserved");

    const geminiBeforeExpiry = await harness.service.waitForTurn({
      agent_id: "gemini:test",
      room_id: codexJoin.room_id,
      max_wait_ms: 0
    });
    expect(geminiBeforeExpiry.status).toBe("not_yet");

    harness.clock.advance(1_001);

    const afterClaimExpiry = harness.service.getRoomState({
      room_id: codexJoin.room_id
    });
    expect(afterClaimExpiry.room.state).toBe("reserved");

    const geminiDuringGoneGrace = await harness.service.waitForTurn({
      agent_id: "gemini:test",
      room_id: codexJoin.room_id,
      max_wait_ms: 0
    });
    expect(geminiDuringGoneGrace).toMatchObject({
      status: "takeover_available",
      room_state: "reserved",
      reason: "claim_timeout",
      reserved_for: "claude:test"
    });

    harness.clock.advance(1_001);

    const state = harness.service.getRoomState({ room_id: codexJoin.room_id });
    expect(state.room.state).toBe("recipient_gone");

    const geminiView = await harness.service.waitForTurn({
      agent_id: "gemini:test",
      room_id: codexJoin.room_id,
      max_wait_ms: 0
    });
    expect(geminiView).toEqual({
      status: "takeover_available",
      room_id: codexJoin.room_id,
      turn_id: codexTurn.turn_id,
      room_state: "recipient_gone",
      reason: "recipient_gone",
      reserved_for: "claude:test"
    });
  });

  test("reserved recipient can claim during gone grace after claim timeout", async () => {
    const harness = createHarness({
      policy: {
        heartbeatIntervalMs: 1_000,
        claimTtlMs: 1_000
      }
    });
    const project = createProject(harness.tempRoot);
    const codexProcess = harness.processRegistry.create("codex");
    const claudeProcess = harness.processRegistry.create("claude");

    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project,
      process_metadata: codexProcess
    });
    harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project,
      process_metadata: claudeProcess
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

    harness.processRegistry.markGone(claudeProcess);
    harness.clock.advance(1_001);

    expect(
      harness.service.getRoomState({ room_id: codexJoin.room_id }).room.state
    ).toBe("reserved");

    const claudeTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "claude:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );

    expect(claudeTurn.reason).toBe("sequence");
    expect(claudeTurn.from_agent_id).toBe("codex:test");
  });

  test("one-shot human presence does not make a reserved turn immediately recipient_gone", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const codexProcess = harness.processRegistry.create("codex");

    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project,
      process_metadata: codexProcess
    });
    harness.service.joinPath({
      agent_id: "human:alice",
      context_path: project,
      process_metadata: {
        session_kind: "human_cli",
        display_name: "alice"
      }
    });
    harness.service.joinPath({
      agent_id: "gemini:test",
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

    const state = harness.service.getRoomState({ room_id: codexJoin.room_id });
    expect(state.room.state).toBe("reserved");
    expect(state.room.reserved_for).toBe("human:alice");

    const geminiView = await harness.service.waitForTurn({
      agent_id: "gemini:test",
      room_id: codexJoin.room_id,
      max_wait_ms: 0
    });
    expect(geminiView.status).toBe("not_yet");
  });

  test("a returning human CLI can reclaim a reserved turn after a stale guardian exits", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const codexProcess = harness.processRegistry.create("codex");
    const guardianProcess = harness.processRegistry.create(
      "alice",
      "human_guardian"
    );

    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project,
      process_metadata: codexProcess
    });
    harness.service.joinPath({
      agent_id: "human:alice",
      context_path: project,
      process_metadata: guardianProcess
    });

    const codexTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );
    const handoff = validHandoff();

    harness.service.releaseStick({
      room_id: codexJoin.room_id,
      agent_id: "codex:test",
      lease_id: codexTurn.lease_id,
      expected_turn_id: codexTurn.turn_id,
      handoff
    });

    harness.processRegistry.markGone(guardianProcess);

    const staleState = harness.service.getRoomState({ room_id: codexJoin.room_id });
    expect(staleState.room.state).toBe("reserved");

    harness.service.joinPath({
      agent_id: "human:alice",
      context_path: project,
      process_metadata: {
        session_kind: "human_cli",
        display_name: "alice"
      }
    });

    const recoveredState = harness.service.getRoomState({
      room_id: codexJoin.room_id
    });
    expect(recoveredState.room.state).toBe("reserved");

    const humanTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "human:alice",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );

    expect(humanTurn.reason).toBe("sequence");
    expect(humanTurn.from_agent_id).toBe("codex:test");
    expect(humanTurn.handoff).toEqual(handoff);
  });

  test("dormant room stays readable and a new live member can resume it", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const codexProcess = harness.processRegistry.create("codex");
    const claudeProcess = harness.processRegistry.create("claude");
    const geminiProcess = harness.processRegistry.create("gemini");

    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project,
      process_metadata: codexProcess
    });
    harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project,
      process_metadata: claudeProcess
    });

    harness.processRegistry.markGone(codexProcess);
    harness.processRegistry.markGone(claudeProcess);

    const dormantState = harness.service.getRoomState({
      room_id: codexJoin.room_id
    });
    expect(dormantState.room.state).toBe("dormant");

    harness.service.joinPath({
      agent_id: "gemini:test",
      context_path: project,
      process_metadata: geminiProcess
    });

    const geminiTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "gemini:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );

    expect(geminiTurn.reason).toBe("open_claim");
  });

  test("only one process can claim an idle room under contention", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const room = harness.service.joinPath({
      agent_id: "agent-0",
      context_path: project
    });

    const agents = ["agent-0", "agent-1", "agent-2", "agent-3", "agent-4"];
    for (const agent of agents.slice(1)) {
      harness.service.joinPath({
        agent_id: agent,
        context_path: project
      });
    }
    harness.service.close();
    services.splice(services.indexOf(harness.service), 1);

    const startAt = Date.now() + 500;
    // The worker must share the parent fake clock so idle TTL purging
    // does not depend on the wall-clock date when the test runs.
    const workerNowIso = harness.clock.now().toISOString();
    const results = await Promise.all(
      agents.map((agent) =>
        runClaimWorker({
          dbPath: harness.dbPath,
          roomId: room.room_id,
          agentId: agent,
          startAt,
          nowIso: workerNowIso
        })
      )
    );

    const winners = results.filter(
      (result) => result.status === "your_turn"
    );
    expect(winners).toHaveLength(1);
    expect(
      new Set(results.map((result) => result.status))
    ).toEqual(new Set(["your_turn", "not_yet"]));
  });

  test("two wait-events workers contending for idle claim produce one owner and one event-bearing waiter", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const room = harness.service.joinPath({
      agent_id: "agent-0",
      context_path: project
    });
    harness.service.joinPath({
      agent_id: "agent-1",
      context_path: project
    });
    harness.service.joinPath({
      agent_id: "agent-2",
      context_path: project
    });

    harness.service.sendMessage({
      agent_id: "agent-2",
      room_id: room.room_id,
      to_agent_id: "agent-0",
      body: "queued for agent 0"
    });
    harness.service.sendMessage({
      agent_id: "agent-2",
      room_id: room.room_id,
      to_agent_id: "agent-1",
      body: "queued for agent 1"
    });
    harness.service.close();
    services.splice(services.indexOf(harness.service), 1);

    const startAt = Date.now() + 500;
    const workerNowIso = harness.clock.now().toISOString();
    const results = await Promise.all(
      ["agent-0", "agent-1"].map((agent) =>
        runClaimWorker({
          dbPath: harness.dbPath,
          roomId: room.room_id,
          agentId: agent,
          startAt,
          nowIso: workerNowIso,
          includeEvents: true,
          afterEventSeq: 0
        })
      )
    );

    expect(results.filter((result) => result.status === "your_turn")).toHaveLength(1);
    const waiter = results.find((result) => result.status === "not_yet");
    expect(waiter).toBeDefined();
    expect(waiter?.events?.map((event) => event.event_type)).toEqual([
      "message_sent"
    ]);
  });

  test("wait_for_turn is idempotent for the current owner and returns the same lease", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const join = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });

    const firstTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: join.room_id,
        max_wait_ms: 0
      })
    );
    expect(firstTurn.reason).toBe("open_claim");

    const secondTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: join.room_id,
        max_wait_ms: 0
      })
    );

    expect(secondTurn.reason).toBe("already_owner");
    expect(secondTurn.lease_id).toBe(firstTurn.lease_id);
    expect(secondTurn.turn_id).toBe(firstTurn.turn_id);
    expect(secondTurn.handoff).toBeNull();
    expect(secondTurn.from_agent_id).toBeNull();

    // Idempotency must not mint a new claim event.
    const events = harness.service.getRoomEvents({ room_id: join.room_id });
    const claimCount = events.filter(
      (event) => event.event_type === "claim"
    ).length;
    expect(claimCount).toBe(1);
  });

  test("wait_for_turn not_yet payload carries ownership context", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });
    harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project
    });

    const codexTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );

    const claudeWait = await harness.service.waitForTurn({
      agent_id: "claude:test",
      room_id: codexJoin.room_id,
      max_wait_ms: 0
    });

    expect(claudeWait.status).toBe("not_yet");
    if (claudeWait.status !== "not_yet") return;

    expect(claudeWait.turn_id).toBe(codexTurn.turn_id);
    expect(claudeWait.current_owner).toBe("codex:test");
    expect(claudeWait.reserved_for).toBeUndefined();
    expect(claudeWait.lease_expires_at).toBeDefined();
    expect(claudeWait.claim_expires_at).toBeUndefined();
    expect(
      Date.parse(claudeWait.lease_expires_at ?? "")
    ).toBeGreaterThan(harness.clock.now().getTime());
    expect(claudeWait.room_state).toBe("owned");
  });

  test("wait_for_turn not_yet payload exposes claim_expires_at while a handoff is reserved", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });
    harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project
    });
    harness.service.joinPath({
      agent_id: "gemini:test",
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

    // gemini is not the reserved recipient (claude is), so gemini should see
    // a not_yet payload that names the reserved recipient and claim expiry.
    const geminiWait = await harness.service.waitForTurn({
      agent_id: "gemini:test",
      room_id: codexJoin.room_id,
      max_wait_ms: 0
    });

    expect(geminiWait.status).toBe("not_yet");
    if (geminiWait.status !== "not_yet") return;

    expect(geminiWait.current_owner).toBeUndefined();
    expect(geminiWait.reserved_for).toBe("claude:test");
    expect(geminiWait.claim_expires_at).toBeDefined();
    expect(geminiWait.lease_expires_at).toBeUndefined();
    expect(geminiWait.room_state).toBe("reserved");
  });

  test("wait_for_turn does not short-circuit to already_owner when the owner lease has expired", async () => {
    const harness = createHarness({
      policy: {
        ownerLeaseTtlMs: 1_000
      }
    });
    const project = createProject(harness.tempRoot);
    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });
    harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project
    });

    const codexTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );
    expect(codexTurn.reason).toBe("open_claim");

    harness.clock.advance(1_001);

    // After lease expiry, re-asking as the (nominal) owner must not hand back
    // a your_turn result that would let the caller keep using a stale lease.
    const codexAfterExpiry = await harness.service.waitForTurn({
      agent_id: "codex:test",
      room_id: codexJoin.room_id,
      max_wait_ms: 0
    });

    expect(codexAfterExpiry.status).toBe("not_yet");
  });

  test("kick_member removes a gone member and records a kick event", async () => {
    const harness = createHarness({ policy: { heartbeatIntervalMs: 1_000 } });
    const project = createProject(harness.tempRoot);
    const claudeProcess = harness.processRegistry.create("claude");
    const codexProcess = harness.processRegistry.create("codex");

    const claudeJoin = harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project,
      process_metadata: claudeProcess
    });
    harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project,
      process_metadata: codexProcess
    });

    harness.processRegistry.markGone(codexProcess);
    harness.clock.advance(2_001);

    const result = harness.service.kickMember({
      room_id: claudeJoin.room_id,
      agent_id: "claude:test",
      target_agent_id: "codex:test",
      reason: "stale codex session"
    });

    expect(result.status).toBe("kicked");
    expect(result.kicked_agent_id).toBe("codex:test");
    expect(result.remaining_members).toBe(1);
    expect(result.target_was_owner).toBe(false);

    const state = harness.service.getRoomState({ room_id: claudeJoin.room_id });
    expect(state.members.map((m) => m.agent_id)).toEqual(["claude:test"]);

    const events = harness.service.getRoomEvents({
      room_id: claudeJoin.room_id,
      after_event_seq: 0
    });
    const kickEvent = events.find((e) => e.event_type === "kick");
    expect(kickEvent).toBeDefined();
    expect(kickEvent?.from_agent_id).toBe("claude:test");
    expect(kickEvent?.to_agent_id).toBe("codex:test");
    expect(kickEvent?.reason).toBe("stale codex session");
  });

  test("kick_member rejects an active target without force", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const claudeProcess = harness.processRegistry.create("claude");
    const codexProcess = harness.processRegistry.create("codex");

    const claudeJoin = harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project,
      process_metadata: claudeProcess
    });
    harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project,
      process_metadata: codexProcess
    });

    expect(() =>
      harness.service.kickMember({
        room_id: claudeJoin.room_id,
        agent_id: "claude:test",
        target_agent_id: "codex:test"
      })
    ).toThrowProtocolError("target_active");
  });

  test("kick_member with force removes an active target", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const claudeProcess = harness.processRegistry.create("claude");
    const codexProcess = harness.processRegistry.create("codex");

    const claudeJoin = harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project,
      process_metadata: claudeProcess
    });
    harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project,
      process_metadata: codexProcess
    });

    const result = harness.service.kickMember({
      room_id: claudeJoin.room_id,
      agent_id: "claude:test",
      target_agent_id: "codex:test",
      force: true
    });

    expect(result.status).toBe("kicked");
    expect(result.remaining_members).toBe(1);
  });

  test("kick_member clears ownership when the target was the owner", async () => {
    const harness = createHarness({ policy: { heartbeatIntervalMs: 1_000 } });
    const project = createProject(harness.tempRoot);
    const codexProcess = harness.processRegistry.create("codex");
    const claudeProcess = harness.processRegistry.create("claude");

    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project,
      process_metadata: codexProcess
    });
    harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project,
      process_metadata: claudeProcess
    });

    asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );

    harness.processRegistry.markGone(codexProcess);
    harness.clock.advance(2_001);

    const result = harness.service.kickMember({
      room_id: codexJoin.room_id,
      agent_id: "claude:test",
      target_agent_id: "codex:test"
    });

    expect(result.target_was_owner).toBe(true);
    const state = harness.service.getRoomState({ room_id: codexJoin.room_id });
    expect(state.room.owner).toBeNull();
    expect(state.room.state).toBe("idle");
  });

  test("kick_member deletes the room when no active members remain", async () => {
    const harness = createHarness({ policy: { heartbeatIntervalMs: 1_000 } });
    const project = createProject(harness.tempRoot);
    const claudeProcess = harness.processRegistry.create("claude");
    const codexProcess = harness.processRegistry.create("codex");

    const claudeJoin = harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project,
      process_metadata: claudeProcess
    });
    harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project,
      process_metadata: codexProcess
    });

    // Both processes are gone past the silence grace; the caller can still kick
    // (touchMember refreshes their last_seen_at), and the room collapses since
    // nobody else remains alive.
    harness.processRegistry.markGone(codexProcess);
    harness.clock.advance(2_001);
    harness.processRegistry.markGone(claudeProcess);

    const result = harness.service.kickMember({
      room_id: claudeJoin.room_id,
      agent_id: "claude:test",
      target_agent_id: "codex:test"
    });

    expect(result.status).toBe("room_deleted");
    expect(result.remaining_members).toBe(0);
    expect(() =>
      harness.service.getRoomState({ room_id: claudeJoin.room_id })
    ).toThrowProtocolError("room_not_found");
  });

  test("kick_member rejects self-kick", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const join = harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project
    });

    expect(() =>
      harness.service.kickMember({
        room_id: join.room_id,
        agent_id: "claude:test",
        target_agent_id: "claude:test"
      })
    ).toThrowProtocolError("cannot_kick_self");
  });

  test("kick_member rejects a non-member caller", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const join = harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project
    });

    expect(() =>
      harness.service.kickMember({
        room_id: join.room_id,
        agent_id: "stranger:test",
        target_agent_id: "claude:test",
        force: true
      })
    ).toThrowProtocolError("unknown_member");
  });

  test("kick_member rejects an unknown target", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const join = harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project
    });

    expect(() =>
      harness.service.kickMember({
        room_id: join.room_id,
        agent_id: "claude:test",
        target_agent_id: "ghost:test",
        force: true
      })
    ).toThrowProtocolError("unknown_target");
  });

  test("joining a new same-process harness session retires a superseded owner", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const codexProcess = harness.processRegistry.create("codex");
    const guardianProcess = harness.processRegistry.create(
      "codex:old",
      "human_guardian"
    );
    const oldSession = withHarnessInstance(
      codexProcess,
      "codex",
      "harness:old"
    );
    const oldGuard = withHarnessInstance(
      guardianProcess,
      "codex",
      "harness:old",
      codexProcess
    );
    const newSession = withHarnessInstance(
      codexProcess,
      "codex",
      "harness:new"
    );

    const oldJoin = harness.service.joinPath({
      agent_id: "codex:old",
      context_path: project,
      process_metadata: oldSession
    });
    asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:old",
        room_id: oldJoin.room_id,
        max_wait_ms: 0
      })
    );
    harness.service.joinPath({
      agent_id: "codex:old",
      context_path: project,
      process_metadata: oldGuard
    });

    const guardedState = harness.service.getRoomState({ room_id: oldJoin.room_id });
    const guardedOwner = guardedState.members.find(
      (member) => member.agent_id === "codex:old"
    );
    expect(guardedOwner?.pid).toBe(guardianProcess.pid);
    expect(guardedOwner?.harness_pid).toBe(codexProcess.pid);

    const newJoin = harness.service.joinPath({
      agent_id: "codex:new",
      context_path: project,
      process_metadata: newSession
    });

    expect(newJoin.warning).toContain("Superseded previous harness session(s): codex:old");
    expect(newJoin.room_state.owner).toBeNull();
    expect(newJoin.room_state.state).toBe("idle");
    expect(newJoin.room_state.lease_id).toBeNull();

    const state = harness.service.getRoomState({ room_id: oldJoin.room_id });
    expect(state.members.map((member) => member.agent_id)).not.toContain(
      "codex:old"
    );

    const supersededEvent = harness.service
      .getRoomEvents({ room_id: oldJoin.room_id })
      .find((event) => event.event_type === "session_superseded");
    expect(supersededEvent?.from_agent_id).toBe("codex:new");
    expect(supersededEvent?.to_agent_id).toBe("codex:old");
    expect(supersededEvent?.reason).toContain(
      "superseded by newer codex session"
    );

    const newTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:new",
        room_id: oldJoin.room_id,
        max_wait_ms: 0
      })
    );
    expect(newTurn.reason).toBe("open_claim");
  });

  test("joining a different-process harness session does not retire an owner", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const oldProcess = harness.processRegistry.create("codex");
    const newProcess = harness.processRegistry.create("codex");

    const oldJoin = harness.service.joinPath({
      agent_id: "codex:old",
      context_path: project,
      process_metadata: withHarnessInstance(
        oldProcess,
        "codex",
        "harness:old"
      )
    });
    asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:old",
        room_id: oldJoin.room_id,
        max_wait_ms: 0
      })
    );

    const newJoin = harness.service.joinPath({
      agent_id: "codex:new",
      context_path: project,
      process_metadata: withHarnessInstance(
        newProcess,
        "codex",
        "harness:new"
      )
    });

    expect(newJoin.warning).toBeUndefined();
    expect(newJoin.room_state.owner).toBe("codex:old");

    const waitResult = await harness.service.waitForTurn({
      agent_id: "codex:new",
      room_id: oldJoin.room_id,
      max_wait_ms: 0
    });
    expect(waitResult.status).toBe("not_yet");
    if (waitResult.status !== "not_yet") return;
    expect(waitResult.current_owner).toBe("codex:old");
  });

  test("joining a new same-process harness session preserves a superseded recipient handoff", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const codexProcess = harness.processRegistry.create("codex");
    const handoff = validHandoff();

    const claudeJoin = harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project
    });
    harness.service.joinPath({
      agent_id: "codex:old",
      context_path: project,
      process_metadata: withHarnessInstance(
        codexProcess,
        "codex",
        "harness:old"
      )
    });

    const claudeTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "claude:test",
        room_id: claudeJoin.room_id,
        max_wait_ms: 0
      })
    );
    harness.service.releaseStick({
      room_id: claudeJoin.room_id,
      agent_id: "claude:test",
      lease_id: claudeTurn.lease_id,
      expected_turn_id: claudeTurn.turn_id,
      handoff
    });

    expect(
      harness.service.getRoomState({ room_id: claudeJoin.room_id }).room
        .reserved_for
    ).toBe("codex:old");

    const newJoin = harness.service.joinPath({
      agent_id: "codex:new",
      context_path: project,
      process_metadata: withHarnessInstance(
        codexProcess,
        "codex",
        "harness:new"
      )
    });

    expect(newJoin.room_state.reserved_for).toBeNull();
    expect(newJoin.room_state.pending_handoff_event_seq).not.toBeNull();

    const newTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:new",
        room_id: claudeJoin.room_id,
        max_wait_ms: 0
      })
    );
    expect(newTurn.reason).toBe("sequence");
    expect(newTurn.from_agent_id).toBe("claude:test");
    expect(newTurn.handoff).toEqual(handoff);
  });

  test("wait_for_turn with auto_claim=false returns plain not_yet on a truly idle room", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const join = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });

    const result = await harness.service.waitForTurn({
      agent_id: "codex:test",
      room_id: join.room_id,
      max_wait_ms: 0,
      auto_claim: false
    });

    expect(result.status).toBe("not_yet");
    if (result.status !== "not_yet") return;
    expect(result.reason).toBeUndefined();
    expect(result.hint).toBeUndefined();
    expect(result.current_owner).toBeUndefined();
    expect(result.reserved_for).toBeUndefined();

    const events = harness.service.getRoomEvents({ room_id: join.room_id });
    expect(events.some((event) => event.event_type === "claim")).toBe(false);
  });

  test("wait_for_turn with auto_claim=false short-returns with a hint the first time an idle room has a pending handoff", async () => {
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

    const room = harness.service.listRooms({ context_path: project }).rooms[0];
    expect(room.reserved_for).toBeNull();
    expect(room.pending_handoff_event_seq).not.toBeNull();

    const result = await harness.service.waitForTurn({
      agent_id: "codex:test",
      room_id: codexJoin.room_id,
      max_wait_ms: 0,
      auto_claim: false
    });

    expect(result.status).toBe("not_yet");
    if (result.status !== "not_yet") return;
    expect(result.reason).toBe("auto_claim_disabled");
    expect(result.hint).toContain("pending handoff");
  });

  test("wait_for_turn with auto_claim=false stops hinting on subsequent parks against the same pending handoff", async () => {
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

    const first = await harness.service.waitForTurn({
      agent_id: "codex:test",
      room_id: codexJoin.room_id,
      max_wait_ms: 0,
      auto_claim: false
    });
    expect(first.status).toBe("not_yet");
    if (first.status !== "not_yet") return;
    expect(first.reason).toBe("auto_claim_disabled");

    const second = await harness.service.waitForTurn({
      agent_id: "codex:test",
      room_id: codexJoin.room_id,
      max_wait_ms: 0,
      auto_claim: false
    });
    expect(second.status).toBe("not_yet");
    if (second.status !== "not_yet") return;
    expect(second.reason).toBeUndefined();
    expect(second.hint).toBeUndefined();
  });

  test("wait_for_turn with auto_claim=false hints again when a new pending handoff replaces an acknowledged one", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });

    const firstTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );
    harness.service.releaseStick({
      room_id: codexJoin.room_id,
      agent_id: "codex:test",
      lease_id: firstTurn.lease_id,
      expected_turn_id: firstTurn.turn_id,
      handoff: validHandoff()
    });

    const firstHint = await harness.service.waitForTurn({
      agent_id: "codex:test",
      room_id: codexJoin.room_id,
      max_wait_ms: 0,
      auto_claim: false
    });
    expect(firstHint.status).toBe("not_yet");
    if (firstHint.status !== "not_yet") return;
    expect(firstHint.reason).toBe("auto_claim_disabled");

    const secondTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );
    harness.service.releaseStick({
      room_id: codexJoin.room_id,
      agent_id: "codex:test",
      lease_id: secondTurn.lease_id,
      expected_turn_id: secondTurn.turn_id,
      handoff: validHandoff()
    });

    const secondHint = await harness.service.waitForTurn({
      agent_id: "codex:test",
      room_id: codexJoin.room_id,
      max_wait_ms: 0,
      auto_claim: false
    });
    expect(secondHint.status).toBe("not_yet");
    if (secondHint.status !== "not_yet") return;
    expect(secondHint.reason).toBe("auto_claim_disabled");
    expect(secondHint.hint).toContain("pending handoff");
  });

  test("wait_for_turn with auto_claim=false hints a newly joined member even if another member already acknowledged the same pending handoff", async () => {
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

    const codexHint = await harness.service.waitForTurn({
      agent_id: "codex:test",
      room_id: codexJoin.room_id,
      max_wait_ms: 0,
      auto_claim: false
    });
    expect(codexHint.status).toBe("not_yet");
    if (codexHint.status !== "not_yet") return;
    expect(codexHint.reason).toBe("auto_claim_disabled");

    harness.service.joinPath({
      agent_id: "gemini:test",
      context_path: project
    });

    const geminiHint = await harness.service.waitForTurn({
      agent_id: "gemini:test",
      room_id: codexJoin.room_id,
      max_wait_ms: 0,
      auto_claim: false
    });
    expect(geminiHint.status).toBe("not_yet");
    if (geminiHint.status !== "not_yet") return;
    expect(geminiHint.reason).toBe("auto_claim_disabled");
    expect(geminiHint.hint).toContain("pending handoff");
  });

  test("wait_for_turn with auto_claim default still claims idle rooms", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const join = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });

    const result = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: join.room_id,
        max_wait_ms: 0
      })
    );
    expect(result.reason).toBe("open_claim");
  });

  test("wait_for_turn with auto_claim=false still returns your_turn for the current owner", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const join = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });

    const firstTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: join.room_id,
        max_wait_ms: 0
      })
    );

    const parkedAsOwner = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: join.room_id,
        max_wait_ms: 0,
        auto_claim: false
      })
    );

    expect(parkedAsOwner.reason).toBe("already_owner");
    expect(parkedAsOwner.lease_id).toBe(firstTurn.lease_id);
    expect(parkedAsOwner.turn_id).toBe(firstTurn.turn_id);
  });

  test("wait_for_turn with auto_claim=false still returns your_turn for the reserved recipient", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });
    harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project
    });

    const codexTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );

    const handoff = validHandoff();
    harness.service.releaseStick({
      room_id: codexJoin.room_id,
      agent_id: "codex:test",
      lease_id: codexTurn.lease_id,
      expected_turn_id: codexTurn.turn_id,
      handoff
    });

    const claudeTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "claude:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0,
        auto_claim: false
      })
    );

    expect(claudeTurn.reason).toBe("sequence");
    expect(claudeTurn.from_agent_id).toBe("codex:test");
    expect(claudeTurn.handoff).toEqual(handoff);
  });

  test("wait_for_turn with auto_claim=false surfaces takeover_available after owner lease timeout", async () => {
    const harness = createHarness({
      policy: {
        ownerLeaseTtlMs: 1_000
      }
    });
    const project = createProject(harness.tempRoot);
    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });
    harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project
    });

    const codexTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );

    harness.clock.advance(1_001);

    const result = await harness.service.waitForTurn({
      agent_id: "claude:test",
      room_id: codexJoin.room_id,
      max_wait_ms: 0,
      auto_claim: false
    });

    expect(result).toEqual({
      status: "takeover_available",
      room_id: codexJoin.room_id,
      turn_id: codexTurn.turn_id,
      room_state: "stale_owner",
      reason: "owner_timeout",
      current_owner: "codex:test"
    });
  });

  test("wait_for_turn with auto_claim=false surfaces takeover_available after claim timeout", async () => {
    const harness = createHarness({
      policy: {
        claimTtlMs: 1_000,
        presenceTtlMs: 60_000
      }
    });
    const project = createProject(harness.tempRoot);
    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });
    harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project
    });
    harness.service.joinPath({
      agent_id: "gemini:test",
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

    harness.clock.advance(1_001);

    const result = await harness.service.waitForTurn({
      agent_id: "gemini:test",
      room_id: codexJoin.room_id,
      max_wait_ms: 0,
      auto_claim: false
    });

    expect(result).toEqual({
      status: "takeover_available",
      room_id: codexJoin.room_id,
      turn_id: codexTurn.turn_id,
      room_state: "reserved",
      reason: "claim_timeout",
      reserved_for: "claude:test"
    });
  });

  test("wait_for_turn with auto_claim=false returns not_yet when another agent owns the stick", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });
    harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project
    });

    asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );

    const claudeWait = await harness.service.waitForTurn({
      agent_id: "claude:test",
      room_id: codexJoin.room_id,
      max_wait_ms: 0,
      auto_claim: false
    });

    expect(claudeWait.status).toBe("not_yet");
    if (claudeWait.status !== "not_yet") return;
    expect(claudeWait.current_owner).toBe("codex:test");
    expect(claudeWait.reason).toBeUndefined();
  });
});

describe("issue #29: presence and liveness track the harness, not the guardian", () => {
  test("member liveness prefers the harness pid over the bare guardian pid", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const { combined, guardian, harnessProc } = buildGuardianBackedMetadata(
      harness.processRegistry,
      "codex"
    );

    const join = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project,
      process_metadata: combined
    });

    const statusOf = () =>
      harness.service
        .getRoomState({ room_id: join.room_id })
        .members.find((m) => m.agent_id === "codex:test")?.status;

    // Both processes alive → active.
    expect(statusOf()).toBe("active");

    // The per-turn guardian process exits (as it does after a release), but the
    // harness lives on. Liveness must follow the harness, so the member stays
    // active — this is the "live harness reads as inactive" failure (Defect 2).
    harness.processRegistry.markGone(guardian);
    expect(statusOf()).toBe("active");

    // Now the harness itself exits. Even though the bare guardian pid is also
    // gone here, the decisive signal is the harness identity → inactive.
    harness.processRegistry.markGone(harnessProc);
    expect(statusOf()).toBe("inactive");
  });

  test("guardian heartbeat renews the lease without faking harness presence (Defect 3)", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });
    const turn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );

    // Read without an agent_id so the read itself does not refresh presence.
    const before = harness.service.getRoomState({ room_id: codexJoin.room_id });
    const seenBefore = before.members.find(
      (m) => m.agent_id === "codex:test"
    )?.last_seen_at;
    const leaseBefore = before.room.lease_expires_at;

    harness.clock.advance(60_000);
    const hb = harness.service.heartbeat({
      agent_id: "codex:test",
      room_id: codexJoin.room_id,
      lease_id: turn.lease_id,
      expected_turn_id: turn.turn_id
    });

    // The lease was renewed...
    expect(Date.parse(hb.lease_expires_at)).toBeGreaterThan(
      Date.parse(leaseBefore!)
    );

    // ...but the owning member's presence did NOT move. A guardian renewal must
    // not masquerade as harness activity, or an abandoned owner would look
    // permanently active and could never be reclaimed.
    const after = harness.service.getRoomState({ room_id: codexJoin.room_id });
    const seenAfter = after.members.find(
      (m) => m.agent_id === "codex:test"
    )?.last_seen_at;
    expect(seenAfter).toBe(seenBefore);
  });

  test("relinquishOwnership surrenders the turn straight to idle (Tier-1 guardian purge)", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });
    const turn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );

    // A guardian whose turn/lease no longer matches (lost a race to a takeover
    // or graceful release) must not clobber the room: it is a no-op.
    const noop = harness.service.relinquishOwnership({
      agent_id: "codex:test",
      room_id: codexJoin.room_id,
      lease_id: "00000000-0000-0000-0000-000000000000",
      expected_turn_id: turn.turn_id
    });
    expect(noop.status).toBe("noop");
    expect(
      harness.service.getRoomState({ room_id: codexJoin.room_id }).room.owner
    ).toBe("codex:test");

    // With the matching lease, the harness-dead guardian surrenders the turn
    // straight to idle so a waiter can claim immediately (no lease-TTL wait).
    const result = harness.service.relinquishOwnership({
      agent_id: "codex:test",
      room_id: codexJoin.room_id,
      lease_id: turn.lease_id,
      expected_turn_id: turn.turn_id
    });
    expect(result.status).toBe("relinquished");

    const room = harness.service.getRoomState({
      room_id: codexJoin.room_id
    }).room;
    expect(room.owner).toBeNull();
    expect(room.reserved_for).toBeNull();
    expect(room.state).toBe("idle");

    const events = harness.service.getRoomEvents({ room_id: codexJoin.room_id });
    expect(
      events.some(
        (e) => e.event_type === "release" && e.reason === "harness_gone"
      )
    ).toBe(true);
  });

  test("owner_idle: a waiting peer can take over an alive-but-idle owner (Tier-2)", async () => {
    const harness = createHarness({
      policy: { ownerActivityTtlMs: 5_000, presenceTtlMs: 60_000 }
    });
    const project = createProject(harness.tempRoot);
    const codexProc = harness.processRegistry.create("codex", "harness_cli");
    const codexMeta: ProcessMetadata = {
      ...codexProc,
      harness_name: "codex",
      harness_session_id: "codex-session",
      harness_host_id: harness.processRegistry.hostId,
      harness_pid: codexProc.pid,
      harness_process_started_at: codexProc.process_started_at
    };
    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project,
      process_metadata: codexMeta
    });
    harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project
    });

    const codexTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "codex:test",
        room_id: codexJoin.room_id,
        max_wait_ms: 0
      })
    );

    // While the owner is fresh, a waiting peer just gets not_yet.
    const early = await harness.service.waitForTurn({
      agent_id: "claude:test",
      room_id: codexJoin.room_id,
      max_wait_ms: 0
    });
    expect(early.status).toBe("not_yet");

    // The owner runs no `tt` command for longer than ownerActivityTtlMs. Its
    // harness is still alive and (in production) its guardian keeps the lease
    // renewed — so this is neither owner_gone nor owner_timeout.
    harness.clock.advance(6_000);

    const offered = await harness.service.waitForTurn({
      agent_id: "claude:test",
      room_id: codexJoin.room_id,
      max_wait_ms: 0
    });
    expect(offered.status).toBe("takeover_available");
    if (offered.status === "takeover_available") {
      expect(offered.reason).toBe("owner_idle");
      expect(offered.room_state).toBe("owner_idle");
      expect(offered.current_owner).toBe("codex:test");
    }

    // The peer exercises the offered takeover.
    const taken = harness.service.takeoverStick({
      agent_id: "claude:test",
      room_id: codexJoin.room_id,
      expected_turn_id: codexTurn.turn_id,
      reason: "owner idle past activity ttl"
    });
    expect(taken.status).toBe("your_turn");
    expect(taken.reason).toBe("owner_idle");
    expect(taken.revoked_agent_id).toBe("codex:test");
  });

  test("owner_idle is peer-gated and any owner command clears it (operator's implicit-liveness rule)", async () => {
    const harness = createHarness({
      policy: { ownerActivityTtlMs: 5_000, presenceTtlMs: 60_000 }
    });
    const project = createProject(harness.tempRoot);
    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });
    harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project
    });
    await harness.service.waitForTurn({
      agent_id: "codex:test",
      room_id: codexJoin.room_id,
      max_wait_ms: 0
    });

    harness.clock.advance(6_000);

    // The owner issues a non-guardian command (a broadcast message). This is a
    // tt tool use, so it must refresh presence and un-idle the session.
    harness.service.sendMessage({
      agent_id: "codex:test",
      room_id: codexJoin.room_id,
      body: "still here, just heads-down editing"
    });

    const afterActivity = await harness.service.waitForTurn({
      agent_id: "claude:test",
      room_id: codexJoin.room_id,
      max_wait_ms: 0
    });
    expect(afterActivity.status).toBe("not_yet");

    // And the gate itself: with no peer waiting, owner_idle is never surfaced —
    // it is only ever evaluated inside a waiter's own wait call. (Re-idle, then
    // confirm the owner re-waiting on itself is not offered its own turn.)
    harness.clock.advance(6_000);
    const ownerWait = await harness.service.waitForTurn({
      agent_id: "codex:test",
      room_id: codexJoin.room_id,
      max_wait_ms: 0
    });
    expect(ownerWait.status).toBe("your_turn");
    if (ownerWait.status === "your_turn") {
      expect(ownerWait.reason).toBe("already_owner");
    }
  });

  test("sustained self-receiver keeps a member visible across the presence window (Defect 1)", async () => {
    const harness = createHarness({ policy: { presenceTtlMs: 10_000 } });
    const project = createProject(harness.tempRoot);
    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });
    harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project
    });

    const visibleClaude = () =>
      harness.service
        .getRoomState({ room_id: codexJoin.room_id })
        .members.find((m) => m.agent_id === "claude:test")?.status;

    // Past the presence window with no activity, claude reads as inactive...
    harness.clock.advance(11_000);
    expect(visibleClaude()).toBe("inactive");

    // ...but a sustained self-targeted event wait (the §2 ambient receiver) is
    // the documented presence primitive: watching refreshes presence.
    await harness.service.waitForEvents({
      agent_id: "claude:test",
      room_id: codexJoin.room_id,
      target_agent_id: "self",
      max_wait_ms: 0
    });
    expect(visibleClaude()).toBe("active");
  });

  test("a never-joined sustained self-receiver registers and becomes visible (Defect 1)", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    // Only codex joins; claude NEVER runs tt join — it only watches.
    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });

    const claudePresent = () =>
      harness.service
        .getRoomState({ room_id: codexJoin.room_id })
        .members.find((m) => m.agent_id === "claude:test");

    expect(claudePresent()).toBeUndefined();

    // claude starts a sustained self-receiver carrying its harness identity but
    // never joined. The documented presence primitive must register it.
    const claudeProc = harness.processRegistry.create("claude", "harness_cli");
    await harness.service.waitForEvents({
      agent_id: "claude:test",
      room_id: codexJoin.room_id,
      target_agent_id: "self",
      max_wait_ms: 0,
      process_metadata: {
        ...claudeProc,
        harness_name: "claude",
        harness_session_id: "claude-session",
        harness_host_id: harness.processRegistry.hostId,
        harness_pid: claudeProc.pid,
        harness_process_started_at: claudeProc.process_started_at
      }
    });

    const claude = claudePresent();
    expect(claude).toBeDefined();
    expect(claude?.status).toBe("active");
    // Watching is presence, not turn interest.
    expect(claude?.last_wait_at).toBeNull();
  });

  test("an ordinary non-guardian command re-stamps stale process metadata (Defect 1 contract)", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    // Join with no process metadata: the row has no usable identity yet.
    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });

    const codexRow = () =>
      harness.service
        .getRoomState({ room_id: codexJoin.room_id })
        .members.find((m) => m.agent_id === "codex:test");

    expect(codexRow()?.harness_pid).toBeNull();

    // An ordinary command (sendMessage) carrying the harness identity must
    // re-stamp the row — repair is not exclusive to tt join.
    const codexProc = harness.processRegistry.create("codex", "harness_cli");
    harness.service.sendMessage({
      agent_id: "codex:test",
      room_id: codexJoin.room_id,
      body: "checking in",
      process_metadata: {
        ...codexProc,
        harness_name: "codex",
        harness_session_id: "codex-session",
        harness_host_id: harness.processRegistry.hostId,
        harness_pid: codexProc.pid,
        harness_process_started_at: codexProc.process_started_at
      }
    });

    expect(codexRow()?.harness_pid).toBe(codexProc.pid);
    expect(codexRow()?.harness_process_started_at).toBe(
      codexProc.process_started_at
    );
  });
});

function buildGuardianBackedMetadata(
  registry: ReturnType<typeof createProcessRegistry>,
  displayName: string
): {
  combined: ProcessMetadata;
  guardian: ProcessMetadata;
  harnessProc: ProcessMetadata;
} {
  // Mirror what the real metadata merge produces for an owner: the bare pid is
  // the per-turn guardian (sessionKind human_guardian, highest priority), while
  // the harness_* fields point at the durable harness process.
  const harnessProc = registry.create(displayName, "harness_cli");
  const guardian = registry.create(displayName, "human_guardian");
  const combined: ProcessMetadata = {
    host_id: registry.hostId,
    pid: guardian.pid,
    process_started_at: guardian.process_started_at,
    session_kind: "human_guardian",
    display_name: displayName,
    harness_name: displayName,
    harness_session_id: `${displayName}-session`,
    harness_host_id: registry.hostId,
    harness_pid: harnessProc.pid,
    harness_process_started_at: harnessProc.process_started_at
  };
  return { combined, guardian, harnessProc };
}

function createHarness(
  options: {
    policy?: Partial<Policy>;
    processLivenessChecker?: (metadata: ProcessMetadata) => ProcessLiveness;
  } = {}
) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-"));
  tempRoots.push(tempRoot);

  const clock = fakeClock();
  const processRegistry = createProcessRegistry();
  const dbPath = path.join(tempRoot, "state", "rooms.sqlite");
  const service = new TalkingStickService({
    dbPath,
    now: clock.now,
    policy: options.policy,
    hostId: processRegistry.hostId,
    processLivenessChecker:
      options.processLivenessChecker ?? processRegistry.checker
  });
  services.push(service);

  return { tempRoot, dbPath, clock, service, processRegistry };
}

function createProject(tempRoot: string): string {
  const project = path.join(tempRoot, "project");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "package.json"), "{}\n");
  return fs.realpathSync.native(project);
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

function createProcessRegistry() {
  const hostId = "test-host";
  let nextPid = 10_000;
  const states = new Map<string, ProcessLiveness>();

  function key(metadata: ProcessMetadata): string {
    return [
      metadata.host_id ?? hostId,
      metadata.pid ?? "none",
      metadata.process_started_at ?? "none"
    ].join(":");
  }

  return {
    hostId,
    create(displayName: string, sessionKind = "mcp_harness"): ProcessMetadata {
      const metadata: ProcessMetadata = {
        host_id: hostId,
        pid: nextPid,
        process_started_at: `start-${nextPid}`,
        session_kind: sessionKind,
        display_name: displayName
      };
      nextPid += 1;
      states.set(key(metadata), "alive");
      return metadata;
    },
    markGone(metadata: ProcessMetadata) {
      states.set(key(metadata), "gone");
    },
    checker(metadata: ProcessMetadata): ProcessLiveness {
      if (
        metadata.pid === undefined ||
        metadata.pid === null ||
        metadata.process_started_at === undefined ||
        metadata.process_started_at === null
      ) {
        return "unknown";
      }

      return states.get(key(metadata)) ?? "unknown";
    }
  };
}

function withHarnessInstance(
  metadata: ProcessMetadata,
  harnessName: string,
  harnessSessionId: string,
  harnessProcess: ProcessMetadata = metadata
): ProcessMetadata {
  return {
    ...metadata,
    harness_name: harnessName,
    harness_session_id: harnessSessionId,
    harness_host_id: harnessProcess.host_id ?? null,
    harness_pid: harnessProcess.pid ?? null,
    harness_process_started_at: harnessProcess.process_started_at ?? null
  };
}

function validHandoff(): Handoff {
  return {
    status: "Finished the current step.",
    next_action: "Continue with the next step."
  };
}

function countRows(
  service: TalkingStickService,
  tableName: "path_rooms" | "room_members" | "room_events"
): number {
  return service.db
    .prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM ${tableName}`)
    .get()?.count ?? 0;
}

function asYourTurn(result: WaitForTurnResult) {
  expect(result.status).toBe("your_turn");
  if (result.status !== "your_turn") {
    throw new Error(`Expected your_turn, got ${result.status}`);
  }
  return result;
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
      message: () => `expected function to throw ProtocolError ${expectedCode}`
    };
  }
});

async function runClaimWorker(input: {
  dbPath: string;
  roomId: string;
  agentId: string;
  startAt: number;
  nowIso?: string;
  includeEvents?: boolean;
  afterEventSeq?: number;
  autoClaim?: boolean;
  maxWaitMs?: number;
}): Promise<{
  status: string;
  reason?: string;
  events?: Array<{ event_type: string; to_agent_id: string | null; body?: string }>;
}> {
  const workerPath = fileURLToPath(
    new URL("./fixtures/claim-worker.ts", import.meta.url)
  );
  const tsxBin = path.join(process.cwd(), "node_modules", ".bin", "tsx");

  const child = spawn(
    tsxBin,
    [
      workerPath,
      JSON.stringify({
        dbPath: input.dbPath,
        roomId: input.roomId,
        agentId: input.agentId,
        startAt: input.startAt,
        nowIso: input.nowIso,
        includeEvents: input.includeEvents,
        afterEventSeq: input.afterEventSeq,
        autoClaim: input.autoClaim,
        maxWaitMs: input.maxWaitMs
      })
    ],
    {
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("close", resolve);
  });

  if (exitCode !== 0) {
    throw new Error(`worker failed (${exitCode}): ${stderr}`);
  }

  return JSON.parse(stdout) as {
    status: string;
    reason?: string;
    events?: Array<{ event_type: string; to_agent_id: string | null; body?: string }>;
  };
}

declare module "vitest" {
  interface Assertion {
    toThrowProtocolError(expectedCode: string): void;
  }

  interface AsymmetricMatchersContaining {
    toThrowProtocolError(expectedCode: string): void;
  }
}
