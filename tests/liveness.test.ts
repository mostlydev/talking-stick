import { describe, expect, test } from "vitest";
import {
  createDefaultProcessLivenessChecker,
  type ProcessInspection,
  type ProcessInspector
} from "../src/index.js";

describe("createDefaultProcessLivenessChecker", () => {
  const HOST = "test-host";

  test("returns alive when startTime matches exactly", () => {
    const inspector = fakeInspector({
      22150: inspection("Thu Apr 23 18:10:55 2026")
    });
    const checker = createDefaultProcessLivenessChecker(HOST, inspector);

    expect(
      checker({
        host_id: HOST,
        pid: 22150,
        process_started_at: "Thu Apr 23 18:10:55 2026",
        session_kind: "harness_cli",
        display_name: "claude"
      })
    ).toBe("alive");
  });

  test("returns alive when startTime matches after trim (tolerates whitespace drift)", () => {
    const inspector = fakeInspector({
      22150: inspection("Thu Apr 23 18:10:55 2026  ")
    });
    const checker = createDefaultProcessLivenessChecker(HOST, inspector);

    expect(
      checker({
        host_id: HOST,
        pid: 22150,
        process_started_at: "  Thu Apr 23 18:10:55 2026",
        session_kind: "harness_cli",
        display_name: "claude"
      })
    ).toBe("alive");
  });

  test("returns unknown (not gone) when pid is alive but startTime strings mismatch — format-drift regression", () => {
    // Reproduces the observed bug: one harness process wrote the truncated form
    // "u Apr 23 18:10:55 2026" (pre-fix slice), another server reads the same
    // pid and inspects a freshly parsed "Thu Apr 23 18:10:55 2026". The pid is
    // the same live process; the verdict must not be "gone".
    const inspector = fakeInspector({
      22150: inspection("Thu Apr 23 18:10:55 2026")
    });
    const checker = createDefaultProcessLivenessChecker(HOST, inspector);

    expect(
      checker({
        host_id: HOST,
        pid: 22150,
        process_started_at: "u Apr 23 18:10:55 2026",
        session_kind: "harness_cli",
        display_name: "claude"
      })
    ).toBe("unknown");
  });

  test("returns gone when inspect() returns null (ESRCH / pid truly dead)", () => {
    const inspector = fakeInspector({});
    const checker = createDefaultProcessLivenessChecker(HOST, inspector);

    expect(
      checker({
        host_id: HOST,
        pid: 999999,
        process_started_at: "Thu Apr 23 18:10:55 2026",
        session_kind: "harness_cli",
        display_name: "claude"
      })
    ).toBe("gone");
  });

  test("returns unknown when host_id does not match currentHostId (cross-host)", () => {
    const inspector = fakeInspector({
      22150: inspection("Thu Apr 23 18:10:55 2026")
    });
    const checker = createDefaultProcessLivenessChecker(HOST, inspector);

    expect(
      checker({
        host_id: "other-host",
        pid: 22150,
        process_started_at: "Thu Apr 23 18:10:55 2026",
        session_kind: "harness_cli",
        display_name: "claude"
      })
    ).toBe("unknown");
  });

  test("returns unknown when process_started_at is missing", () => {
    const inspector = fakeInspector({});
    const checker = createDefaultProcessLivenessChecker(HOST, inspector);

    expect(
      checker({
        host_id: HOST,
        pid: 22150,
        process_started_at: null,
        session_kind: "harness_cli",
        display_name: "claude"
      })
    ).toBe("unknown");
  });
});

function inspection(startTime: string): ProcessInspection {
  return {
    pid: 0,
    ppid: null,
    startTime,
    command: "node"
  };
}

function fakeInspector(
  processes: Record<number, ProcessInspection>
): ProcessInspector {
  return {
    inspect(pid) {
      const found = processes[pid];
      if (!found) return null;
      return { ...found, pid };
    }
  };
}
