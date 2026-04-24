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
      waitForTurnMaxWaitMs: 30_000,
      waitForTurnPollMs: 250
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
      "wojtek",
      "human_guardian"
    );
    const transientCliProcess = harness.processRegistry.create(
      "wojtek",
      "human_cli"
    );

    const humanJoin = harness.service.joinPath({
      agent_id: "human:wojtek",
      context_path: project,
      process_metadata: guardianProcess
    });

    const humanTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "human:wojtek",
        room_id: humanJoin.room_id,
        max_wait_ms: 0
      })
    );

    harness.service.joinPath({
      agent_id: "human:wojtek",
      context_path: project,
      process_metadata: transientCliProcess
    });
    harness.processRegistry.markGone(transientCliProcess);

    const state = harness.service.getRoomState({ room_id: humanJoin.room_id });
    expect(state.room.state).toBe("owned");

    const heartbeat = harness.service.heartbeat({
      room_id: humanJoin.room_id,
      agent_id: "human:wojtek",
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

  test("recipient_gone becomes diagnostic only after claim timeout expires", async () => {
    const harness = createHarness({
      policy: {
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
      agent_id: "human:wojtek",
      context_path: project,
      process_metadata: {
        session_kind: "human_cli",
        display_name: "wojtek"
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
    expect(state.room.reserved_for).toBe("human:wojtek");

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
      "wojtek",
      "human_guardian"
    );

    const codexJoin = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project,
      process_metadata: codexProcess
    });
    harness.service.joinPath({
      agent_id: "human:wojtek",
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
      agent_id: "human:wojtek",
      context_path: project,
      process_metadata: {
        session_kind: "human_cli",
        display_name: "wojtek"
      }
    });

    const recoveredState = harness.service.getRoomState({
      room_id: codexJoin.room_id
    });
    expect(recoveredState.room.state).toBe("reserved");

    const humanTurn = asYourTurn(
      await harness.service.waitForTurn({
        agent_id: "human:wojtek",
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
    const results = await Promise.all(
      agents.map((agent) =>
        runClaimWorker({
          dbPath: harness.dbPath,
          roomId: room.room_id,
          agentId: agent,
          startAt
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
});

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
}): Promise<{ status: string }> {
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
        startAt: input.startAt
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

  return JSON.parse(stdout) as { status: string };
}

declare module "vitest" {
  interface Assertion {
    toThrowProtocolError(expectedCode: string): void;
  }

  interface AsymmetricMatchersContaining {
    toThrowProtocolError(expectedCode: string): void;
  }
}
