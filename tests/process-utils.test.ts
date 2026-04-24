import { describe, expect, test } from "vitest";
import {
  createSystemProcessInspector,
  terminateKnownProcess,
  type ProcessInspection,
  type ProcessInspector
} from "../src/index.js";

describe("terminateKnownProcess", () => {
  test("signals only when the exact process start time still matches", () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const inspector = fakeInspector({
      4242: {
        pid: 4242,
        ppid: 1,
        startTime: "Thu Apr 23 12:00:00 2026",
        command: "node guardian"
      }
    });

    const terminated = terminateKnownProcess(
      {
        pid: 4242,
        process_started_at: "Thu Apr 23 12:00:00 2026"
      },
      {
        inspector,
        signaler: {
          kill(pid, signal) {
            signals.push({ pid, signal });
          }
        }
      }
    );

    expect(terminated).toBe(true);
    expect(signals).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  });

  test("does not signal when the pid was reused by another process", () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const inspector = fakeInspector({
      4242: {
        pid: 4242,
        ppid: 1,
        startTime: "Thu Apr 23 12:30:00 2026",
        command: "node unrelated"
      }
    });

    const terminated = terminateKnownProcess(
      {
        pid: 4242,
        process_started_at: "Thu Apr 23 12:00:00 2026"
      },
      {
        inspector,
        signaler: {
          kill(pid, signal) {
            signals.push({ pid, signal });
          }
        }
      }
    );

    expect(terminated).toBe(false);
    expect(signals).toEqual([]);
  });

  test("does not signal when metadata is incomplete or kill throws", () => {
    const inspector = fakeInspector({
      4242: {
        pid: 4242,
        ppid: 1,
        startTime: "Thu Apr 23 12:00:00 2026",
        command: "node guardian"
      }
    });

    expect(
      terminateKnownProcess(
        {
          pid: null,
          process_started_at: "Thu Apr 23 12:00:00 2026"
        },
        { inspector }
      )
    ).toBe(false);

    expect(
      terminateKnownProcess(
        {
          pid: 4242,
          process_started_at: "Thu Apr 23 12:00:00 2026"
        },
        {
          inspector,
          signaler: {
            kill() {
              throw new Error("nope");
            }
          }
        }
      )
    ).toBe(false);
  });
});

describe("createSystemProcessInspector", () => {
  test("uses one ps call to capture both lstart and command, with cache", () => {
    let calls = 0;
    const inspector = createSystemProcessInspector({
      cacheTtlMs: 1_000,
      processExists: () => true,
      execFile(_file, args) {
        calls += 1;
        expect(args).toEqual([
          "-o",
          "ppid=",
          "-o",
          "lstart=",
          "-o",
          "command=",
          "-p",
          "4242"
        ]);
        return "  56919 Thu Apr 23 12:00:00 2026 node guardian\n";
      }
    });

    const first = inspector.inspect(4242);
    const second = inspector.inspect(4242);

    expect(first).toEqual({
      pid: 4242,
      ppid: 56919,
      startTime: "Thu Apr 23 12:00:00 2026",
      command: "node guardian"
    });
    expect(second).toEqual(first);
    expect(calls).toBe(1);
  });

  test("returns null (decisively gone) when processExists says no, without calling ps", () => {
    let psCalls = 0;
    const inspector = createSystemProcessInspector({
      processExists: () => false,
      execFile() {
        psCalls += 1;
        return "";
      }
    });

    expect(inspector.inspect(25253)).toBeNull();
    expect(psCalls).toBe(0);
  });

  test("returns undefined (unknown) only when ps itself fails unexpectedly", () => {
    const inspector = createSystemProcessInspector({
      processExists: () => true,
      execFile() {
        throw new Error("ps failed unexpectedly");
      }
    });

    expect(inspector.inspect(4242)).toBeUndefined();
  });
});

function fakeInspector(
  processes: Record<number, ProcessInspection>
): ProcessInspector {
  return {
    inspect(pid) {
      return processes[pid] ?? null;
    }
  };
}
