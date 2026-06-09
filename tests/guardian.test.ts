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

const { spawnGuardian } = await import("../src/cli/guardian.js");

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
