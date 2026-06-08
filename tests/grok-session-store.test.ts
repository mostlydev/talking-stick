import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runGrokSessionHookCommand } from "../src/cli/grok-session-hook.js";
import {
  appendGrokSessionRecord,
  findGrokSessionRecord,
  readGrokSessionRecords,
  type GrokSessionRecord,
  type ProcessInspector
} from "../src/index.js";

const tempDirs: string[] = [];
const now = new Date("2026-06-08T20:00:00.000Z");

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Grok session hook store", () => {
  test("matches the newest exact process and workspace record", () => {
    const { logPath, workspace } = makeTempLog();
    appendGrokSessionRecord(
      record("session-a", workspace, {
        grok_pid: 100,
        grok_process_started_at: "Mon Jun  8 12:00:00 2026"
      }),
      { logPath }
    );

    const matched = findGrokSessionRecord({
      logPath,
      workspaceRoot: workspace,
      grokPid: 100,
      grokProcessStartedAt: "Mon Jun  8 12:00:00 2026",
      now
    });

    expect(matched?.grok_session_id).toBe("session-a");
  });

  test("ignores sessions whose latest row is SessionEnd", () => {
    const { logPath, workspace } = makeTempLog();
    appendGrokSessionRecord(record("session-a", workspace), { logPath });
    appendGrokSessionRecord(
      record("session-a", workspace, { event: "SessionEnd" }),
      { logPath }
    );

    const matched = findGrokSessionRecord({
      logPath,
      workspaceRoot: workspace,
      grokPid: null,
      grokProcessStartedAt: null,
      now
    });

    expect(matched).toBeNull();
  });

  test("uses only unambiguous same-workspace fallback records", () => {
    const { logPath, workspace } = makeTempLog();
    appendGrokSessionRecord(record("session-a", workspace), { logPath });

    expect(
      findGrokSessionRecord({
        logPath,
        workspaceRoot: workspace,
        grokPid: null,
        grokProcessStartedAt: null,
        now
      })?.grok_session_id
    ).toBe("session-a");

    appendGrokSessionRecord(record("session-b", workspace), { logPath });
    expect(
      findGrokSessionRecord({
        logPath,
        workspaceRoot: workspace,
        grokPid: null,
        grokProcessStartedAt: null,
        now
      })
    ).toBeNull();
  });

  test("the hook command records env session context and Grok ancestry", async () => {
    const { logPath, workspace } = makeTempLog();
    const inspector = fakeInspector({
      100: {
        startTime: "Mon Jun  8 12:00:00 2026",
        command: "/Users/alice/.local/bin/grok",
        ppid: 1
      },
      200: {
        startTime: "Mon Jun  8 12:01:00 2026",
        command: "sh -c tt grok-session-hook",
        ppid: 100
      }
    });

    await runGrokSessionHookCommand({
      env: {
        GROK_HOOK_EVENT: "pre_tool_use",
        GROK_SESSION_ID: "session-a",
        GROK_WORKSPACE_ROOT: workspace
      },
      stdin: JSON.stringify({
        cwd: workspace,
        timestamp: now.toISOString()
      }),
      parentPid: 200,
      inspector,
      logPath
    });

    expect(readGrokSessionRecords(logPath)).toEqual([
      {
        source: "grok_hook",
        grok_session_id: "session-a",
        workspace_root: workspace,
        cwd: workspace,
        event: "pre_tool_use",
        observed_at: now.toISOString(),
        grok_pid: 100,
        grok_process_started_at: "Mon Jun  8 12:00:00 2026"
      }
    ]);
  });
});

function makeTempLog(): { logPath: string; workspace: string } {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-sessions-"));
  tempDirs.push(tempRoot);
  const workspace = path.join(tempRoot, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  return {
    logPath: path.join(tempRoot, "grok-sessions.jsonl"),
    workspace
  };
}

function record(
  grokSessionId: string,
  workspaceRoot: string,
  overrides: Partial<GrokSessionRecord> = {}
): GrokSessionRecord {
  return {
    source: "grok_hook",
    grok_session_id: grokSessionId,
    workspace_root: workspaceRoot,
    cwd: workspaceRoot,
    event: "session_start",
    observed_at: now.toISOString(),
    grok_pid: null,
    grok_process_started_at: null,
    ...overrides
  };
}

function fakeInspector(
  processes: Record<
    number,
    { startTime: string | null; command: string | null; ppid?: number | null }
  >
): ProcessInspector {
  return {
    inspect(pid) {
      const process = processes[pid];
      if (!process) {
        return null;
      }

      return {
        pid,
        ppid: process.ppid ?? null,
        startTime: process.startTime,
        command: process.command
      };
    }
  };
}
