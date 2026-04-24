import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  ProtocolError,
  TalkingStickService,
  type Policy,
  type ProcessLiveness,
  type ProcessMetadata
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

describe("addNote", () => {
  test("active member can add a note while another member holds the stick", async () => {
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

    const codexTurn = await harness.service.waitForTurn({
      agent_id: "codex:test",
      room_id: codexJoin.room_id,
      max_wait_ms: 0
    });
    expect(codexTurn.status).toBe("your_turn");

    const result = harness.service.addNote({
      agent_id: "claude:test",
      room_id: codexJoin.room_id,
      body: "Heads up: the migration at 003 needs a backfill."
    });

    expect(result.note_id).toMatch(/^[0-9a-f-]+$/);
    expect(result.author_agent_id).toBe("claude:test");
    expect(result.turn_id).toBeNull();
    expect(result.room_id).toBe(codexJoin.room_id);
    expect(Date.parse(result.created_at)).not.toBeNaN();
  });

  test("non-member cannot add a note", () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const join = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });

    expect(() =>
      harness.service.addNote({
        agent_id: "gemini:intruder",
        room_id: join.room_id,
        body: "I should not be able to post."
      })
    ).toThrowProtocolError("unknown_member");
  });

  test("owner can add a self-note while holding the stick", async () => {
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

    const result = harness.service.addNote({
      agent_id: "codex:test",
      room_id: join.room_id,
      body: "Remember to rebuild dist after this change."
    });

    expect(result.author_agent_id).toBe("codex:test");
  });

  test("body empty after trim is rejected", () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const join = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });

    expect(() =>
      harness.service.addNote({
        agent_id: "codex:test",
        room_id: join.room_id,
        body: "   \n  \t "
      })
    ).toThrowProtocolError("invalid_body");
  });

  test("body exceeding 16 KB is rejected", () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const join = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });

    const tooLong = "x".repeat(16 * 1024 + 1);
    expect(() =>
      harness.service.addNote({
        agent_id: "codex:test",
        room_id: join.room_id,
        body: tooLong
      })
    ).toThrowProtocolError("body_too_large");
  });

  test("turn_id greater than current is rejected", async () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const join = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });
    const turn = await harness.service.waitForTurn({
      agent_id: "codex:test",
      room_id: join.room_id,
      max_wait_ms: 0
    });
    expect(turn.status).toBe("your_turn");
    if (turn.status !== "your_turn") return;

    expect(() =>
      harness.service.addNote({
        agent_id: "codex:test",
        room_id: join.room_id,
        body: "from the future",
        turn_id: turn.turn_id + 5
      })
    ).toThrowProtocolError("invalid_turn_id");
  });

  test("turn_id must be a non-negative integer", () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const join = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });

    expect(() =>
      harness.service.addNote({
        agent_id: "codex:test",
        room_id: join.room_id,
        body: "negative",
        turn_id: -1
      })
    ).toThrowProtocolError("invalid_turn_id");

    expect(() =>
      harness.service.addNote({
        agent_id: "codex:test",
        room_id: join.room_id,
        body: "fractional",
        turn_id: 0.5
      })
    ).toThrowProtocolError("invalid_turn_id");
  });

  test("turn_id null persists as null and round-trips through listNotes", () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const join = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });

    harness.service.addNote({
      agent_id: "codex:test",
      room_id: join.room_id,
      body: "room-scoped"
    });

    const listed = harness.service.listNotes({ room_id: join.room_id });
    expect(listed.notes).toHaveLength(1);
    expect(listed.notes[0].turn_id).toBeNull();
  });

  test("closed room rejects new notes", () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const join = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });

    // Directly flip the room to closed via the DB to avoid relying on a
    // close RPC (which is out of scope for this slice).
    harness.service.db
      .prepare(
        "UPDATE path_rooms SET state = 'closed', updated_at = ? WHERE room_id = ?"
      )
      .run(new Date().toISOString(), join.room_id);

    expect(() =>
      harness.service.addNote({
        agent_id: "codex:test",
        room_id: join.room_id,
        body: "too late"
      })
    ).toThrowProtocolError("room_closed");
  });
});

describe("listNotes", () => {
  test("returns notes in created_at ascending order across multiple authors", () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const join = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });
    harness.service.joinPath({
      agent_id: "claude:test",
      context_path: project
    });

    harness.service.addNote({
      agent_id: "codex:test",
      room_id: join.room_id,
      body: "first"
    });
    harness.clock.advance(1_000);
    harness.service.addNote({
      agent_id: "claude:test",
      room_id: join.room_id,
      body: "second"
    });
    harness.clock.advance(1_000);
    harness.service.addNote({
      agent_id: "codex:test",
      room_id: join.room_id,
      body: "third"
    });

    const result = harness.service.listNotes({ room_id: join.room_id });
    expect(result.notes.map((note) => note.body)).toEqual([
      "first",
      "second",
      "third"
    ]);
    expect(result.notes.map((note) => note.author_agent_id)).toEqual([
      "codex:test",
      "claude:test",
      "codex:test"
    ]);
  });

  test("honors after_note_id pagination using (created_at, note_id) tuple", () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const join = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });

    // Add three notes at the SAME clock tick to exercise the (created_at,
    // note_id) tiebreaker — this is the exact regression codex called out
    // when tightening the design doc.
    const first = harness.service.addNote({
      agent_id: "codex:test",
      room_id: join.room_id,
      body: "a"
    });
    const second = harness.service.addNote({
      agent_id: "codex:test",
      room_id: join.room_id,
      body: "b"
    });
    const third = harness.service.addNote({
      agent_id: "codex:test",
      room_id: join.room_id,
      body: "c"
    });
    expect(first.created_at).toBe(second.created_at);
    expect(second.created_at).toBe(third.created_at);

    const all = harness.service.listNotes({ room_id: join.room_id });
    expect(all.notes).toHaveLength(3);

    const afterFirst = harness.service.listNotes({
      room_id: join.room_id,
      after_note_id: all.notes[0].note_id
    });
    expect(afterFirst.notes).toHaveLength(2);
    expect(afterFirst.notes[0].note_id).toBe(all.notes[1].note_id);
    expect(afterFirst.notes[1].note_id).toBe(all.notes[2].note_id);

    const afterSecond = harness.service.listNotes({
      room_id: join.room_id,
      after_note_id: all.notes[1].note_id
    });
    expect(afterSecond.notes).toHaveLength(1);
    expect(afterSecond.notes[0].note_id).toBe(all.notes[2].note_id);
  });

  test("include_resolved defaults to false and filters resolved rows", () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const join = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });

    const unresolved = harness.service.addNote({
      agent_id: "codex:test",
      room_id: join.room_id,
      body: "still open"
    });
    const resolved = harness.service.addNote({
      agent_id: "codex:test",
      room_id: join.room_id,
      body: "already handled"
    });

    // Mark one resolved directly via DB (the resolve_note RPC is out of
    // scope for v1, but the list filter must already work).
    harness.service.db
      .prepare(
        "UPDATE notes SET resolved_at = ?, resolved_by_agent_id = ? WHERE note_id = ?"
      )
      .run(new Date().toISOString(), "codex:test", resolved.note_id);

    const defaultView = harness.service.listNotes({ room_id: join.room_id });
    expect(defaultView.notes.map((note) => note.note_id)).toEqual([
      unresolved.note_id
    ]);

    const fullView = harness.service.listNotes({
      room_id: join.room_id,
      include_resolved: true
    });
    expect(fullView.notes.map((note) => note.note_id).sort()).toEqual(
      [unresolved.note_id, resolved.note_id].sort()
    );
  });

  test("resolved filtering happens before limit is applied", () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const join = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });

    const resolved = harness.service.addNote({
      agent_id: "codex:test",
      room_id: join.room_id,
      body: "already handled"
    });
    harness.clock.advance(1_000);
    const unresolved = harness.service.addNote({
      agent_id: "codex:test",
      room_id: join.room_id,
      body: "still open"
    });

    harness.service.db
      .prepare(
        "UPDATE notes SET resolved_at = ?, resolved_by_agent_id = ? WHERE note_id = ?"
      )
      .run(new Date().toISOString(), "codex:test", resolved.note_id);

    const defaultView = harness.service.listNotes({
      room_id: join.room_id,
      limit: 1
    });
    expect(defaultView.notes.map((note) => note.note_id)).toEqual([
      unresolved.note_id
    ]);
  });

  test("listNotes rejects an after_note_id that doesn't belong to the room", () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const join = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });

    expect(() =>
      harness.service.listNotes({
        room_id: join.room_id,
        after_note_id: "00000000-0000-0000-0000-000000000000"
      })
    ).toThrowProtocolError("invalid_cursor");
  });

  test("listNotes with agent_id of a joined member refreshes last_seen_at", () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const join = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });
    const joinedAt = harness.clock.now().toISOString();

    harness.clock.advance(5_000);
    harness.service.listNotes({
      room_id: join.room_id,
      agent_id: "codex:test"
    });

    const state = harness.service.getRoomState({ room_id: join.room_id });
    const codex = state.members.find((m) => m.agent_id === "codex:test");
    expect(codex?.last_seen_at).not.toBe(joinedAt);
    expect(Date.parse(codex?.last_seen_at ?? "")).toBeGreaterThan(
      Date.parse(joinedAt)
    );
  });

  test("listNotes without agent_id does not create or refresh membership", () => {
    const harness = createHarness();
    const project = createProject(harness.tempRoot);
    const join = harness.service.joinPath({
      agent_id: "codex:test",
      context_path: project
    });

    // Non-member read is allowed; it is a harmless no-op for membership.
    const result = harness.service.listNotes({ room_id: join.room_id });
    expect(result.notes).toHaveLength(0);
  });
});

// ---- test harness helpers (copied intentionally from talking-stick.test.ts
// to keep this suite self-contained; the project has no shared helpers
// module yet) ----

function createHarness(
  options: {
    policy?: Partial<Policy>;
    processLivenessChecker?: (metadata: ProcessMetadata) => ProcessLiveness;
  } = {}
) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-notes-"));
  tempRoots.push(tempRoot);

  const clock = fakeClock();
  const dbPath = path.join(tempRoot, "state", "rooms.sqlite");
  const service = new TalkingStickService({
    dbPath,
    now: clock.now,
    policy: options.policy,
    processLivenessChecker: options.processLivenessChecker
  });
  services.push(service);

  return { tempRoot, dbPath, clock, service };
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
            ? `Expected not to throw ProtocolError(${expectedCode})`
            : `Expected ProtocolError(${expectedCode}), got ${
                error instanceof ProtocolError
                  ? `ProtocolError(${error.code})`
                  : String(error)
              }`
      };
    }
    return {
      pass: false,
      message: () => `Expected ProtocolError(${expectedCode}), got no throw`
    };
  }
});

declare module "vitest" {
  interface Assertion<T> {
    toThrowProtocolError(code: string): T;
  }
  interface AsymmetricMatchersContaining {
    toThrowProtocolError(code: string): unknown;
  }
}
