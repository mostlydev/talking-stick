import { describe, expect, test, vi } from "vitest";
import { createSystemProcessInspector } from "../src/process-utils.js";
import { executableName, commandExecutable } from "../src/executable-name.js";
import { proveMemberInPane, proveChatMemberInPane } from "../src/launch-identity.js";
import { createDefaultProcessLivenessChecker } from "../src/service.js";
import type { RoomMember } from "../src/types.js";
import { findHarnessRootInAncestry } from "../src/identity.js";

const start = "2026-10-23T17:00:00.1234567Z";
const row = { pid: 42, ppid: 20, startTime: start, command: '"C:\\Program Files\\Codex\\codex.exe" --no-daemon' };

describe("Windows process identity", () => {
  test("one snapshot supplies multiple PIDs and preserves precise UTC identity", () => {
    const execFile = vi.fn(() => JSON.stringify([row, { ...row, pid: 20, ppid: 1 }]));
    const inspector = createSystemProcessInspector({ platform: "win32", processExists: () => true, execFile });
    expect(inspector.inspect(42)).toEqual(row);
    expect(inspector.inspect(20)?.startTime).toBe(start);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0]).toBeDefined();
    const checker = createDefaultProcessLivenessChecker("host", inspector);
    expect(checker({ pid: 42, host_id: "host", process_started_at: start })).toBe("alive");
    expect(checker({ pid: 42, host_id: "host", process_started_at: "older" })).toBe("unknown");
  });

  test.each(["[]", "{}", "not json", JSON.stringify([{ ...row, startTime: null }])])(
    "an incomplete or malformed snapshot is unknown: %s", (output) => {
      const inspector = createSystemProcessInspector({ platform: "win32", processExists: () => true,
        execFile: () => output });
      expect(inspector.inspect(42)).toBeUndefined();
    });

  test("denied probes are unknown, a definitely missing process is gone", () => {
    const execFile = vi.fn(() => { throw new Error("Access denied"); });
    const inspector = createSystemProcessInspector({ platform: "win32", execFile, processExists: (pid) => pid !== 99 });
    expect(inspector.inspect(42)).toBeUndefined();
    expect(inspector.inspect(99)).toBeNull();
    expect(inspector.inspect(-1)).toBeUndefined();
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  test("refreshes the snapshot after TTL and detects a new incarnation", () => {
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const execFile = vi.fn().mockReturnValueOnce(JSON.stringify([row]))
      .mockReturnValue(JSON.stringify([{ ...row, startTime: "2026-10-23T17:01:00.1234567Z" }]));
    try {
      const inspector = createSystemProcessInspector({ platform: "win32", processExists: () => true, execFile });
      expect(inspector.inspect(42)?.startTime).toBe(start);
      now = 5_001;
      expect(inspector.inspect(42)?.startTime).not.toBe(start);
    } finally { clock.mockRestore(); }
  });

  test("quoted paths and Windows extensions normalize without weakening POSIX names", () => {
    expect(executableName(commandExecutable(row.command), "win32")).toBe("codex");
    expect(executableName("C:\\apps\\CLAUDE.EXE", "win32")).toBe("claude");
    expect(executableName("/bin/Claude.exe", "linux")).toBe("Claude.exe");
    expect(executableName("C:\\apps\\codex.exe.old", "win32")).toBe("codex.exe.old");
  });

  test("ancestry reaches the harness through a quoted shell path", () => {
    const command = process.platform === "win32"
      ? '"C:\\Program Files\\Codex\\codex.exe" --no-daemon'
      : '/opt/codex --no-daemon';
    const shell = { pid: 50, ppid: 42, startTime: start, command: '"C:\\Program Files\\PowerShell\\pwsh.exe" -Command tt' };
    const inspector = { inspect: (pid: number) => pid === 42 ? { ...row, ppid: 1, command } : null };
    expect(findHarnessRootInAncestry("codex", 50, shell, inspector)).toEqual({ pid: 42, startTime: start });
    if (process.platform === "win32") {
      const reused = { inspect: () => ({ ...row, ppid: 1, startTime: "2026-10-23T17:01:00.1234567Z" }) };
      expect(findHarnessRootInAncestry("codex", 50, shell, reused)).toBeNull();
    }
  });

  test("agent and chat proof confirm Windows processes but reject stale identity", () => {
    const member = { agent_id: "codex:1", status: "active", session_kind: "human_chat", process_liveness: "alive",
      pid: 42, process_started_at: start, harness_pid: 42, harness_process_started_at: start,
      harness_session_id: "harness:session" } as RoomMember;
    const agent = { pane_id: "pane", session_id: "session", name: null, agent: "codex", status: null };
    const deps = { platform: "win32" as const, readStartTime: () => start,
      runner: () => JSON.stringify({ result: { process_info: { foreground_processes:
        [{ pid: 42, argv0: "C:\\Program Files\\Codex\\CODEX.EXE" }] } } }) };
    expect(proveMemberInPane(member, agent, "codex", deps).confirmed).toBe(true);
    expect(proveChatMemberInPane(member, "pane", deps)).toBe(true);
    expect(proveMemberInPane(member, { ...agent, session_id: "other" }, "codex", deps).confirmed).toBe(false);
    expect(proveMemberInPane({ ...member, harness_pid: 43 }, agent, "codex", deps).confirmed).toBe(false);
    expect(proveMemberInPane(member, agent, "codex", { ...deps, readStartTime: () => "old" }).confirmed).toBe(false);
    expect(proveChatMemberInPane(member, "pane", { ...deps, readStartTime: () => "old" })).toBe(false);
  });
});
