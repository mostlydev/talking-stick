import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: spawnMock
  };
});

const { runGuardTick, spawnGuardian } = await import("../src/cli/guardian.js");

class FakeStream extends EventEmitter {
  setEncoding = vi.fn();
  destroy = vi.fn();
}

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: FakeStream;
    stderr: FakeStream;
    pid: number;
    kill: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
  };
  child.stdout = new FakeStream();
  child.stderr = new FakeStream();
  child.pid = 4242;
  child.kill = vi.fn();
  child.unref = vi.fn();
  return child;
}

describe("spawnGuardian", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("kills a detached guardian when readiness times out", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const promise = spawnGuardian({
      agentId: "codex:test",
      canonicalPath: "/repo",
      roomId: "room-1",
      leaseId: "lease-1",
      turnId: 1,
      cliEntryUrl: "file:///tmp/tt-cli.js"
    });

    const rejection = expect(promise).rejects.toThrow(
      /Guardian did not signal readiness in time/
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.stdout.destroy).toHaveBeenCalled();
    expect(child.stderr.destroy).toHaveBeenCalled();
  });
});

describe("runGuardTick", () => {
  test("keeps heartbeating when service retains a fresh gone harness", () => {
    const relinquishOwnership = vi.fn(() => ({
      status: "retained",
      room_id: "room-1"
    }));
    const heartbeat = vi.fn(() => ({
      status: "ok",
      room_id: "room-1",
      turn_id: 1,
      lease_id: "lease-1",
      lease_expires_at: "2026-04-22T12:10:00.000Z"
    }));

    const result = runGuardTick({
      runtime: fakeRuntime({ relinquishOwnership, heartbeat }),
      identity: fakeIdentity(),
      heartbeatInput: fakeHeartbeatInput(),
      harnessRef: {
        pid: 12345,
        process_started_at: "missing"
      },
      inspector: { inspect: () => null }
    });

    expect(result).toBe("continue");
    expect(relinquishOwnership).toHaveBeenCalledOnce();
    expect(heartbeat).toHaveBeenCalledOnce();
  });

  test("exits cleanly after service relinquishes a persistently gone harness", () => {
    const relinquishOwnership = vi.fn(() => ({
      status: "relinquished",
      room_id: "room-1",
      event_seq: 1
    }));
    const heartbeat = vi.fn();

    const result = runGuardTick({
      runtime: fakeRuntime({ relinquishOwnership, heartbeat }),
      identity: fakeIdentity(),
      heartbeatInput: fakeHeartbeatInput(),
      harnessRef: {
        pid: 12345,
        process_started_at: "missing"
      },
      inspector: { inspect: () => null }
    });

    expect(result).toBe("exit_clean");
    expect(relinquishOwnership).toHaveBeenCalledOnce();
    expect(heartbeat).not.toHaveBeenCalled();
  });
});

function fakeRuntime(methods: {
  relinquishOwnership: ReturnType<typeof vi.fn>;
  heartbeat: ReturnType<typeof vi.fn>;
}) {
  return {
    commands: {
      relinquishOwnership: methods.relinquishOwnership,
      heartbeat: methods.heartbeat
    }
  } as never;
}

function fakeIdentity() {
  return {
    agent_id: "codex:test",
    process_metadata: {
      session_kind: "harness_cli",
      display_name: "codex"
    }
  } as never;
}

function fakeHeartbeatInput() {
  return {
    room_id: "room-1",
    lease_id: "lease-1",
    expected_turn_id: 1
  };
}
