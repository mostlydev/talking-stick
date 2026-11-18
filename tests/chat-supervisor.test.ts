import { describe, expect, test } from "vitest";
import {
  headlessCounts, headlessMarker, headlessTransitions, headlessWhoLines, holdRemedy, routeHeadlessWorkers, workerState, workersInRoom,
  type HeadlessLookups, type HeadlessWorker
} from "../src/cli/chat-supervisor.js";
import type { SupervisorWorkerStatus } from "../src/supervisor/snapshot.js";
import type { HoldReason } from "../src/supervisor/state.js";

function worker(overrides: Partial<SupervisorWorkerStatus> = {}): SupervisorWorkerStatus {
  return {
    worker_id: "w1", harness: "claude", cwd: "/repo/pkg", desired: "running", desired_version: 1, hold_reason: null,
    next_start_at: null,
    generation: { generation: 2, state: "idle", pid: 10, session_id: "s1", started_at: "t", ended_at: null },
    generation_process_started_at: "start-10", uncertain_inputs: 0, denied_requests: 0,
    ...overrides
  };
}

function lookups(overrides: Partial<HeadlessLookups> = {}): HeadlessLookups {
  return {
    membersForSession: () => [],
    memberAlive: () => true,
    roomForPath: (cwd) => ({ room_path: cwd === "/repo/pkg" ? "/repo" : cwd, room_id: cwd === "/repo/pkg" ? "root" : null }),
    ...overrides
  };
}

describe("headless worker state", () => {
  test("every hold names the supervisor table's remedy", () => {
    const remedies: Record<HoldReason, string> = {
      auth_required: "tt supervisor resume w1",
      wrong_auth_mode: "tt supervisor resume w1",
      deny_undelivered: "tt supervisor resume w1",
      crash_loop: "tt supervisor resume w1",
      resume_failed: "tt supervisor restart w1 --fresh",
      bootstrap_failed: "tt supervisor restart w1 --fresh",
      prior_generation_alive: "tt supervisor status",
      prior_generation_unknown: "tt supervisor status",
      overflow: "tt supervisor status",
      start_failed: "tt supervisor status",
      protocol_error: "tt supervisor status",
      gate_ineligible: "tt supervisor status"
    };
    for (const [reason, remedy] of Object.entries(remedies) as Array<[HoldReason, string]>) {
      expect(holdRemedy("w1", reason)).toBe(remedy);
      expect(workerState(worker({ hold_reason: reason }), "running"))
        .toEqual({ state: `held: ${reason}`, held: reason, blocked: true, remedy });
    }
  });

  test("a hold outranks the desired state, which outranks the daemon and the generation", () => {
    expect(workerState(worker({ hold_reason: "crash_loop", desired: "paused" }), "stopped").state).toBe("held: crash_loop");
    expect(workerState(worker({ desired: "paused" }), "stopped")).toMatchObject({ state: "paused", blocked: false });
    expect(workerState(worker({ desired: "stopped" }), "stopped")).toMatchObject({ state: "stopped", blocked: false });
    expect(workerState(worker(), "stopped")).toEqual({ state: "supervisor not running", held: null, blocked: true, remedy: "tt supervisor run" });
    // An unconfirmed owner is unknown, never reported as stopped.
    expect(workerState(worker(), "unknown")).toMatchObject({ state: "supervisor state unknown", blocked: false });
    expect(workerState(worker(), "running")).toMatchObject({ state: "ready", blocked: false });
    expect(workerState(worker({ generation: null }), "running").state).toBe("starting");
    const ended = { generation: 2, state: "dead" as const, pid: 10, session_id: "s1", started_at: "t", ended_at: "later" };
    expect(workerState(worker({ generation: ended, next_start_at: "soon" }), "running").state).toBe("restarting");
    expect(workerState(worker({ generation: ended }), "running").state).toBe("exited");
  });

  test("a Codex worker waiting for its login is blocked but not held", () => {
    const waiting = worker({ harness: "codex", generation: { generation: 1, state: "auth_required", pid: 10, session_id: null,
      started_at: "t", ended_at: null } });
    expect(workerState(waiting, "running")).toEqual({ state: "waiting for login", held: null, blocked: true,
      remedy: "sign in to codex; it rechecks" });
  });
});

describe("routing headless workers to rooms", () => {
  const member = { room_id: "pkg", agent_id: "claude:abc", canonical_path: "/repo/pkg", harness_pid: 10,
    harness_process_started_at: "start-10 " };

  test("the exact live process joins; otherwise the exact cwd decides", () => {
    let asked: [string, string] | null = null;
    const joined = routeHeadlessWorkers({ kind: "ready", daemon: "running", workers: [worker()] }, lookups({
      membersForSession: (harness, session) => { asked = [harness, session]; return [member]; }
    }));
    expect(asked).toEqual(["claude", "harness:s1"]);
    expect(joined.workers[0]).toMatchObject({ room_path: "/repo/pkg", room_id: "pkg", agent_id: "claude:abc", state: "ready",
      open_path: "/repo/pkg" });

    const notJoined = routeHeadlessWorkers({ kind: "ready", daemon: "running", workers: [worker()] }, lookups());
    expect(notJoined.workers[0]).toMatchObject({ room_path: "/repo", room_id: "root", agent_id: null });
  });

  test("a reused session id, an ended generation or a departed member never claims a peer", () => {
    const snapshot = (overrides: Partial<SupervisorWorkerStatus>) =>
      ({ kind: "ready" as const, daemon: "running" as const, workers: [worker(overrides)] });
    const reused = lookups({ membersForSession: () => [{ ...member, harness_pid: 99 }] });
    expect(routeHeadlessWorkers(snapshot({}), reused).workers[0].agent_id).toBeNull();
    const restarted = lookups({ membersForSession: () => [{ ...member, harness_process_started_at: "another start" }] });
    expect(routeHeadlessWorkers(snapshot({}), restarted).workers[0].agent_id).toBeNull();
    const withMember = lookups({ membersForSession: () => [member] });
    const ended = { generation: 2, state: "dead" as const, pid: 10, session_id: "s1", started_at: "t", ended_at: "later" };
    expect(routeHeadlessWorkers(snapshot({ generation: ended }), withMember).workers[0].agent_id).toBeNull();
    expect(routeHeadlessWorkers(snapshot({ generation_process_started_at: null }), withMember).workers[0].agent_id).toBeNull();
    const departed = lookups({ membersForSession: () => [member], memberAlive: () => false });
    expect(routeHeadlessWorkers(snapshot({}), departed).workers[0].agent_id).toBeNull();
  });

  test("an unresolvable cwd or failed lookup still lists the worker", () => {
    const failing = lookups({
      membersForSession: () => { throw new Error("room database busy"); },
      roomForPath: () => { throw new Error("no such directory"); }
    });
    const view = routeHeadlessWorkers({ kind: "ready", daemon: "running", workers: [worker({ cwd: "/gone/dir" })] }, failing);
    expect(view.workers[0]).toMatchObject({ worker_id: "w1", room_path: "/gone/dir", room_id: null, agent_id: null });
  });

  test("snapshot conditions become one notice and no workers", () => {
    expect(routeHeadlessWorkers({ kind: "none" }, lookups())).toEqual({ workers: [], notice: null });
    expect(routeHeadlessWorkers({ kind: "needs_migration" }, lookups()).notice).toContain("tt supervisor migrate");
    expect(routeHeadlessWorkers({ kind: "unavailable", reason: "database" }, lookups()).notice)
      .toBe("Supervisor database is unreadable; see tt supervisor status.");
  });

  test("sibling rooms never share workers", () => {
    const view = routeHeadlessWorkers({ kind: "ready", daemon: "running", workers: [
      worker({ worker_id: "a", cwd: "/repo/a" }), worker({ worker_id: "b", cwd: "/repo/b" }), worker({ worker_id: "c", cwd: "/repo/pkg" })
    ] }, lookups({ roomForPath: (cwd) => ({ room_path: cwd, room_id: cwd === "/repo/a" ? "A" : null }) }));
    expect(workersInRoom(view, { room_id: "A", room_path: "/repo/a" }).map((w) => w.worker_id)).toEqual(["a"]);
    expect(workersInRoom(view, { room_id: "B", room_path: "/repo/b" }).map((w) => w.worker_id)).toEqual(["b"]);
    expect(workersInRoom(view, { room_id: null, room_path: "/repo" })).toEqual([]);
  });
});

describe("what chat shows", () => {
  const view = (overrides: Partial<HeadlessWorker>): HeadlessWorker => ({
    worker_id: "w1", harness: "claude", room_path: "/repo", open_path: "/repo", room_id: "root", agent_id: null, state: "ready", held: null,
    blocked: false, remedy: null, denied_requests: 0, uncertain_inputs: 0, ...overrides
  });

  test("/who lines carry the state, membership, counts and remedy", () => {
    expect(headlessWhoLines([
      view({ state: "held: auth_required", held: "auth_required", blocked: true, remedy: "tt supervisor resume w1", denied_requests: 2 }),
      view({ worker_id: "w2", harness: "codex", agent_id: "codex:abc", uncertain_inputs: 1 })
    ], (id) => `name(${id})`)).toEqual([
      "w1 (claude) · held: auth_required · not joined · 2 denied (tt supervisor approvals) → tt supervisor resume w1",
      "w2 (codex) · ready · joined as name(codex:abc) · 1 uncertain"
    ]);
    expect(headlessCounts([view({ blocked: true }), view({})])).toEqual({ headless: 2, blocked: 1 });
  });

  test("the header marker stays short and names where to look", () => {
    expect(headlessMarker(0, 0)).toEqual([]);
    expect(headlessMarker(1, 0)).toEqual(["1 headless blocked · /who", "1 blocked"]);
    expect(headlessMarker(0, 2)).toEqual(["2 headless blocked in other rooms · /rooms", "2 blocked"]);
    expect(headlessMarker(1, 2)).toEqual(["1 headless blocked · /who · 2 in other rooms", "3 blocked"]);
  });

  test("transitions print once on entering, changing and leaving a block, never on the first read", () => {
    const ready = view({});
    const held = view({ state: "held: crash_loop", held: "crash_loop", blocked: true, remedy: "tt supervisor resume w1" });
    expect(headlessTransitions(null, [held])).toEqual([]);
    expect(headlessTransitions(new Map([["w1", ready]]), [held])).toEqual(["Headless w1 is blocked: held: crash_loop. /who shows the fix."]);
    expect(headlessTransitions(new Map([["w1", held]]), [held])).toEqual([]);
    const other = { ...held, state: "held: deny_undelivered" };
    expect(headlessTransitions(new Map([["w1", held]]), [other])).toEqual(["Headless w1 is blocked: held: deny_undelivered. /who shows the fix."]);
    expect(headlessTransitions(new Map([["w1", held]]), [ready])).toEqual(["Headless w1 is no longer blocked: ready."]);
  });
});
