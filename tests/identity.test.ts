import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  appendGrokSessionRecord,
  deriveHarnessCliIdentity,
  deriveHumanCliIdentity,
  type ProcessInspector
} from "../src/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("identity derivation", () => {
  test("derives a stable human CLI agent id with current process metadata", () => {
    const inspector = fakeInspector({
      3210: {
        startTime: "Thu Apr 23 12:00:00 2026",
        command: "/opt/homebrew/bin/node /usr/local/bin/tt wait"
      }
    });

    const identity = deriveHumanCliIdentity({
      username: "alice",
      pid: 3210,
      hostId: "test-host",
      inspector
    });

    expect(identity.agent_id).toBe("human:alice");
    expect(identity.process_metadata).toEqual({
      host_id: null,
      pid: null,
      process_started_at: null,
      session_kind: "human_cli",
      display_name: "alice"
    });
  });

  test("derives exact process metadata for a guardian holder", () => {
    const inspector = fakeInspector({
      3210: {
        startTime: "Thu Apr 23 12:00:00 2026",
        command: "/opt/homebrew/bin/node /usr/local/bin/tt wait"
      }
    });

    const identity = deriveHumanCliIdentity({
      username: "alice",
      pid: 3210,
      hostId: "test-host",
      inspector,
      sessionKind: "human_guardian"
    });

    expect(identity.agent_id).toBe("human:alice");
    expect(identity.process_metadata).toEqual({
      host_id: "test-host",
      pid: 3210,
      process_started_at: "Thu Apr 23 12:00:00 2026",
      session_kind: "human_guardian",
      display_name: "alice"
    });
  });

});

describe("deriveHarnessCliIdentity", () => {
  const inspector = fakeInspector({
    9000: { startTime: "Thu Apr 23 14:00:00 2026", command: "bash", ppid: 8000 },
    8000: { startTime: "Thu Apr 23 13:50:00 2026", command: "claude", ppid: 1 },
    7777: { startTime: "Thu Apr 23 13:45:00 2026", command: "claude", ppid: 1 }
  });

  test("detects Claude Code via CLAUDECODE=1 without explicit export", () => {
    const identity = deriveHarnessCliIdentity({
      env: { CLAUDECODE: "1" },
      username: "alice",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });

    expect(identity).not.toBeNull();
    expect(identity!.agent_id).toMatch(/^claude:[0-9a-f]{8}$/);
    expect(identity!.process_metadata.session_kind).toBe("harness_cli");
    expect(identity!.process_metadata.display_name).toBe("claude");
  });

  test("returns null when no harness env markers are set and no harness in ancestry", () => {
    const neutralInspector = fakeInspector({
      9000: { startTime: "Thu Apr 23 14:00:00 2026", command: "bash", ppid: 8000 },
      8000: { startTime: "Thu Apr 23 13:50:00 2026", command: "bash", ppid: 1 }
    });
    expect(
      deriveHarnessCliIdentity({
        env: {},
        username: "alice",
        parentPid: 9000,
        hostId: "test-host",
        inspector: neutralInspector
      })
    ).toBeNull();
  });

  test("detects Claude Code via ancestry walk when harness export is enabled", () => {
    const identity = deriveHarnessCliIdentity({
      env: { TT_HARNESS_EXPORT: "1" },
      username: "alice",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });

    expect(identity).not.toBeNull();
    expect(identity?.process_metadata.display_name).toBe("claude");
    expect(identity?.agent_id).toMatch(/^claude:[0-9a-f]{8}$/);
  });

  test("detects Claude Code via CLAUDECODE=1 when harness export is enabled", () => {
    const identity = deriveHarnessCliIdentity({
      env: {
        TT_HARNESS_EXPORT: "1",
        CLAUDECODE: "1"
      },
      username: "alice",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });
    expect(identity).not.toBeNull();
    expect(identity!.agent_id).toMatch(/^claude:[0-9a-f]{8}$/);
    expect(identity!.process_metadata).toEqual({
      host_id: "test-host",
      pid: 9000,
      process_started_at: "Thu Apr 23 14:00:00 2026",
      session_kind: "harness_cli",
      display_name: "claude",
      harness_name: "claude",
      harness_session_id: "pid:8000@Thu Apr 23 13:50:00 2026",
      harness_host_id: "test-host",
      harness_pid: 8000,
      harness_process_started_at: "Thu Apr 23 13:50:00 2026"
    });
  });

  test("does not detect Claude from CLAUDE_CODE_EXECPATH alone", () => {
    const identity = deriveHarnessCliIdentity({
      env: { CLAUDE_CODE_EXECPATH: "/opt/claude/2.1.118" },
      username: "alice",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });

    expect(identity).toBeNull();
  });

  test("uses CMUX_CLAUDE_PID as a Claude process hint only after CLAUDECODE", () => {
    const identity = deriveHarnessCliIdentity({
      env: {
        CLAUDECODE: "1",
        CMUX_CLAUDE_PID: "7777"
      },
      username: "alice",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });

    expect(identity).not.toBeNull();
    expect(identity!.process_metadata.pid).toBe(7777);
    expect(identity!.process_metadata.process_started_at).toBe(
      "Thu Apr 23 13:45:00 2026"
    );
  });

  test("ignores CMUX_CLAUDE_PID without CLAUDECODE", () => {
    const identity = deriveHarnessCliIdentity({
      env: { CMUX_CLAUDE_PID: "7777" },
      username: "alice",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });

    expect(identity).toBeNull();
  });

  test("detects Codex and prefers CODEX_THREAD_ID for stable identity across invocations", () => {
    const first = deriveHarnessCliIdentity({
      env: {
        TT_HARNESS_EXPORT: "1",
        CODEX_MANAGED_BY_NPM: "1",
        CODEX_THREAD_ID: "019dbc04-0695-77c0-8e59-2220fadcb7fb"
      },
      username: "alice",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });
    const second = deriveHarnessCliIdentity({
      env: {
        TT_HARNESS_EXPORT: "1",
        CODEX_MANAGED_BY_NPM: "1",
        CODEX_THREAD_ID: "019dbc04-0695-77c0-8e59-2220fadcb7fb"
      },
      username: "alice",
      parentPid: 9001,
      hostId: "test-host",
      inspector
    });
    expect(first!.agent_id).toMatch(/^codex:[0-9a-f]{8}$/);
    expect(first!.agent_id).toBe(second!.agent_id);
    expect(first!.process_metadata.harness_name).toBe("codex");
    expect(first!.process_metadata.harness_session_id).toBe(
      "harness:019dbc04-0695-77c0-8e59-2220fadcb7fb"
    );
  });

  test("detects Codex via CODEX_THREAD_ID even without CODEX_MANAGED_BY_NPM", () => {
    const identity = deriveHarnessCliIdentity({
      env: { CODEX_THREAD_ID: "abc" },
      username: "alice",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });
    expect(identity!.agent_id).toMatch(/^codex:[0-9a-f]{8}$/);
  });

  test("detects Gemini via GEMINI_CLI=1 and falls back to PID-based identity", () => {
    const identity = deriveHarnessCliIdentity({
      env: { GEMINI_CLI: "1" },
      username: "alice",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });
    expect(identity!.agent_id).toMatch(/^gemini:[0-9a-f]{8}$/);
    expect(identity!.process_metadata.session_kind).toBe("harness_cli");
    expect(identity!.process_metadata.display_name).toBe("gemini");
  });

  test("detects Antigravity and prefers conversation id over trajectory id", () => {
    const first = deriveHarnessCliIdentity({
      env: {
        ANTIGRAVITY_AGENT: "1",
        ANTIGRAVITY_CONVERSATION_ID: "conversation-a",
        ANTIGRAVITY_TRAJECTORY_ID: "trajectory-a"
      },
      username: "alice",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });
    const second = deriveHarnessCliIdentity({
      env: {
        ANTIGRAVITY_CONVERSATION_ID: "conversation-a",
        ANTIGRAVITY_TRAJECTORY_ID: "trajectory-b"
      },
      username: "alice",
      parentPid: 9001,
      hostId: "test-host",
      inspector
    });

    expect(first!.agent_id).toMatch(/^antigravity:[0-9a-f]{8}$/);
    expect(first!.agent_id).toBe(second!.agent_id);
    expect(first!.process_metadata).toMatchObject({
      display_name: "antigravity",
      harness_name: "antigravity",
      harness_session_id: "harness:conversation-a"
    });
  });

  test("detects Antigravity with trajectory id when no conversation id is present", () => {
    const identity = deriveHarnessCliIdentity({
      env: { ANTIGRAVITY_TRAJECTORY_ID: "trajectory-a" },
      username: "alice",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });

    expect(identity!.agent_id).toMatch(/^antigravity:[0-9a-f]{8}$/);
    expect(identity!.process_metadata.harness_session_id).toBe(
      "harness:trajectory-a"
    );
  });

  test("detects Antigravity via agy ancestry when harness export is enabled", () => {
    const agyInspector = fakeInspector({
      100: {
        startTime: "Sat Jun 13 14:00:00 2026",
        command: "/usr/local/bin/agy",
        ppid: 1
      },
      200: {
        startTime: "Sat Jun 13 14:01:00 2026",
        command: "zsh",
        ppid: 100
      }
    });

    const identity = deriveHarnessCliIdentity({
      env: { TT_HARNESS_EXPORT: "1" },
      username: "alice",
      parentPid: 200,
      hostId: "test-host",
      inspector: agyInspector
    });

    expect(identity!.agent_id).toMatch(/^antigravity:[0-9a-f]{8}$/);
    expect(identity!.process_metadata).toMatchObject({
      display_name: "antigravity",
      harness_name: "antigravity",
      harness_session_id: "harness:pid:100@Sat Jun 13 14:00:00 2026",
      harness_pid: 100,
      harness_process_started_at: "Sat Jun 13 14:00:00 2026"
    });
  });

  test("detects Grok via cmux launch kind without TT_HARNESS_EXPORT", () => {
    const { workspace, logPath } = makeTempWorkspace();
    const grokInspector = fakeInspector({
      100: {
        startTime: "Mon Jun  8 12:00:00 2026",
        command: "/Users/alice/.local/bin/grok",
        ppid: 1
      },
      200: {
        startTime: "Mon Jun  8 12:01:00 2026",
        command: "zsh",
        ppid: 100
      }
    });

    const identity = deriveHarnessCliIdentity({
      env: { CMUX_AGENT_LAUNCH_KIND: "grok" },
      username: "alice",
      parentPid: 200,
      hostId: "test-host",
      inspector: grokInspector,
      contextPath: workspace,
      grokSessionLogPath: logPath
    });

    expect(identity).not.toBeNull();
    expect(identity!.agent_id).toMatch(/^grok:[0-9a-f]{8}$/);
    expect(identity!.process_metadata).toMatchObject({
      session_kind: "harness_cli",
      display_name: "grok",
      harness_name: "grok",
      harness_session_id: "pid:100@Mon Jun  8 12:00:00 2026",
      harness_pid: 100,
      harness_process_started_at: "Mon Jun  8 12:00:00 2026"
    });
  });

  test("does not treat GROK_SESSION_ID alone as a normal shell marker", () => {
    const identity = deriveHarnessCliIdentity({
      env: { GROK_SESSION_ID: "session-a" },
      username: "alice",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });

    expect(identity).toBeNull();
  });

  test("upgrades Grok cmux identity from hook records when the process matches", () => {
    const { workspace, logPath } = makeTempWorkspace();
    appendGrokSessionRecord(
      {
        source: "grok_hook",
        grok_session_id: "session-a",
        workspace_root: workspace,
        cwd: workspace,
        event: "session_start",
        observed_at: "2026-06-08T20:00:00.000Z",
        grok_pid: 100,
        grok_process_started_at: "Mon Jun  8 12:00:00 2026"
      },
      { logPath }
    );
    const grokInspector = fakeInspector({
      100: {
        startTime: "Mon Jun  8 12:00:00 2026",
        command: "grok",
        ppid: 1
      },
      200: {
        startTime: "Mon Jun  8 12:01:00 2026",
        command: "zsh",
        ppid: 100
      },
      201: {
        startTime: "Mon Jun  8 12:02:00 2026",
        command: "zsh",
        ppid: 100
      }
    });

    const first = deriveHarnessCliIdentity({
      env: { CMUX_AGENT_LAUNCH_KIND: "grok" },
      username: "alice",
      parentPid: 200,
      hostId: "test-host",
      inspector: grokInspector,
      contextPath: workspace,
      grokSessionLogPath: logPath,
      now: new Date("2026-06-08T20:01:00.000Z")
    });
    const second = deriveHarnessCliIdentity({
      env: { CMUX_AGENT_LAUNCH_KIND: "grok" },
      username: "alice",
      parentPid: 201,
      hostId: "test-host",
      inspector: grokInspector,
      contextPath: workspace,
      grokSessionLogPath: logPath,
      now: new Date("2026-06-08T20:01:00.000Z")
    });

    expect(first!.process_metadata.harness_session_id).toBe("harness:session-a");
    expect(first!.agent_id).toBe(second!.agent_id);
  });

  test("detects bare Grok via ancestry and upgrades when a hook record exists", () => {
    const { workspace, logPath } = makeTempWorkspace();
    appendGrokSessionRecord(
      {
        source: "grok_hook",
        grok_session_id: "session-a",
        workspace_root: workspace,
        cwd: workspace,
        event: "session_start",
        observed_at: "2026-06-08T20:00:00.000Z",
        grok_pid: 100,
        grok_process_started_at: "Mon Jun  8 12:00:00 2026"
      },
      { logPath }
    );
    const grokInspector = fakeInspector({
      100: {
        startTime: "Mon Jun  8 12:00:00 2026",
        command: "grok",
        ppid: 1
      },
      200: {
        startTime: "Mon Jun  8 12:01:00 2026",
        command: "zsh",
        ppid: 100
      }
    });

    const identity = deriveHarnessCliIdentity({
      env: {},
      username: "alice",
      parentPid: 200,
      hostId: "test-host",
      inspector: grokInspector,
      contextPath: workspace,
      grokSessionLogPath: logPath,
      now: new Date("2026-06-08T20:01:00.000Z")
    });

    expect(identity!.process_metadata.harness_name).toBe("grok");
    expect(identity!.process_metadata.harness_session_id).toBe("harness:session-a");
  });

  test("does not use ambiguous Grok same-workspace hook fallbacks", () => {
    const { workspace, logPath } = makeTempWorkspace();
    appendGrokSessionRecord(
      {
        source: "grok_hook",
        grok_session_id: "session-a",
        workspace_root: workspace,
        cwd: workspace,
        event: "session_start",
        observed_at: "2026-06-08T20:00:00.000Z",
        grok_pid: null,
        grok_process_started_at: null
      },
      { logPath }
    );
    appendGrokSessionRecord(
      {
        source: "grok_hook",
        grok_session_id: "session-b",
        workspace_root: workspace,
        cwd: workspace,
        event: "session_start",
        observed_at: "2026-06-08T20:01:00.000Z",
        grok_pid: null,
        grok_process_started_at: null
      },
      { logPath }
    );
    const neutralInspector = fakeInspector({
      200: {
        startTime: "Mon Jun  8 12:01:00 2026",
        command: "zsh",
        ppid: 1
      }
    });

    const identity = deriveHarnessCliIdentity({
      env: { CMUX_AGENT_LAUNCH_KIND: "grok" },
      username: "alice",
      parentPid: 200,
      hostId: "test-host",
      inspector: neutralInspector,
      contextPath: workspace,
      grokSessionLogPath: logPath,
      now: new Date("2026-06-08T20:02:00.000Z")
    });

    expect(identity!.process_metadata.harness_session_id).toBe(
      "pid:200@Mon Jun  8 12:01:00 2026"
    );
  });

  test("prefers a native harness marker over the cmux launch kind", () => {
    const identity = deriveHarnessCliIdentity({
      env: { CLAUDECODE: "1", CMUX_AGENT_LAUNCH_KIND: "grok" },
      username: "alice",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });

    expect(identity!.process_metadata.harness_name).toBe("claude");
  });

  test("detects bare Grok via ancestry without cmux or a hook log", () => {
    const { workspace, logPath } = makeTempWorkspace();
    const grokInspector = fakeInspector({
      100: {
        startTime: "Mon Jun  8 12:00:00 2026",
        command: "grok",
        ppid: 1
      },
      200: {
        startTime: "Mon Jun  8 12:01:00 2026",
        command: "zsh",
        ppid: 100
      }
    });

    const identity = deriveHarnessCliIdentity({
      env: {},
      username: "alice",
      parentPid: 200,
      hostId: "test-host",
      inspector: grokInspector,
      contextPath: workspace,
      grokSessionLogPath: logPath
    });

    expect(identity).not.toBeNull();
    expect(identity!.agent_id).toMatch(/^grok:[0-9a-f]{8}$/);
    expect(identity!.process_metadata).toMatchObject({
      display_name: "grok",
      harness_name: "grok",
      harness_session_id: "pid:100@Mon Jun  8 12:00:00 2026",
      harness_pid: 100,
      harness_process_started_at: "Mon Jun  8 12:00:00 2026"
    });
  });

  test("detects OpenCode and prefers OPENCODE_RUN_ID for stable identity", () => {
    const first = deriveHarnessCliIdentity({
      env: {
        OPENCODE: "1",
        OPENCODE_RUN_ID: "run-abc",
        OPENCODE_PID: "12345"
      },
      username: "alice",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });
    const second = deriveHarnessCliIdentity({
      env: {
        OPENCODE: "1",
        OPENCODE_RUN_ID: "run-abc",
        OPENCODE_PID: "99999"
      },
      username: "alice",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });
    expect(first!.agent_id).toMatch(/^opencode:[0-9a-f]{8}$/);
    expect(first!.agent_id).toBe(second!.agent_id);
  });

  test("does not collide identities across harnesses with the same sessionId", () => {
    const codexIdentity = deriveHarnessCliIdentity({
      env: { TT_HARNESS_EXPORT: "1", CODEX_THREAD_ID: "shared" },
      username: "alice",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });
    const opencodeIdentity = deriveHarnessCliIdentity({
      env: { TT_HARNESS_EXPORT: "1", OPENCODE: "1", OPENCODE_RUN_ID: "shared" },
      username: "alice",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });
    expect(codexIdentity!.agent_id.split(":")[1]).not.toBe(
      opencodeIdentity!.agent_id.split(":")[1]
    );
  });

  test("respects an explicit agentId override", () => {
    const identity = deriveHarnessCliIdentity({
      agentId: "claude:forced-id",
      env: { TT_HARNESS_EXPORT: "1", CLAUDECODE: "1" },
      inspector
    });
    expect(identity!.agent_id).toBe("claude:forced-id");
  });

  test("uses an explicitly exported harness agent id when provided", () => {
    const identity = deriveHarnessCliIdentity({
      env: { TT_HARNESS_AGENT_ID: "claude:4d685f30" },
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });
    expect(identity).not.toBeNull();
    expect(identity!.agent_id).toBe("claude:4d685f30");
    expect(identity!.process_metadata.display_name).toBe("claude");
  });

  test("uses a terminal-emulator session id as sessionId fallback for Gemini", () => {
    const identity = deriveHarnessCliIdentity({
      env: {
        TT_HARNESS_EXPORT: "1",
        GEMINI_CLI: "1",
        ITERM_SESSION_ID: "w0t0p0:ABCDEF"
      },
      username: "alice",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });
    expect(identity!.agent_id).toMatch(/^gemini:[0-9a-f]{8}$/);
  });

  test("terminal-emulator fallback keeps identity stable across invocations in the same tab", () => {
    const a = deriveHarnessCliIdentity({
      env: { TT_HARNESS_EXPORT: "1", GEMINI_CLI: "1", CMUX_TAB_ID: "tab-abc" },
      username: "alice",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });
    const b = deriveHarnessCliIdentity({
      env: { TT_HARNESS_EXPORT: "1", GEMINI_CLI: "1", CMUX_TAB_ID: "tab-abc" },
      username: "alice",
      parentPid: 9001,
      hostId: "test-host",
      inspector
    });
    expect(a!.agent_id).toBe(b!.agent_id);
  });

  test("different terminal tabs produce different identities within the same harness", () => {
    const a = deriveHarnessCliIdentity({
      env: { TT_HARNESS_EXPORT: "1", GEMINI_CLI: "1", CMUX_TAB_ID: "tab-one" },
      username: "alice",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });
    const b = deriveHarnessCliIdentity({
      env: { TT_HARNESS_EXPORT: "1", GEMINI_CLI: "1", CMUX_TAB_ID: "tab-two" },
      username: "alice",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });
    expect(a!.agent_id).not.toBe(b!.agent_id);
  });

  test("prefers harness root ancestry over terminal ids when the harness has no session id", () => {
    const ancestryInspector = fakeInspector({
      8000: { startTime: "Thu Apr 23 13:50:00 2026", command: "claude", ppid: 1 },
      9000: { startTime: "Thu Apr 23 14:00:00 2026", command: "bash", ppid: 8000 },
      9001: { startTime: "Thu Apr 23 14:05:00 2026", command: "bash", ppid: 8000 }
    });

    const first = deriveHarnessCliIdentity({
      env: {
        CLAUDECODE: "1",
        ITERM_SESSION_ID: "w0t0p0:first"
      },
      username: "alice",
      parentPid: 9000,
      hostId: "test-host",
      inspector: ancestryInspector
    });
    const second = deriveHarnessCliIdentity({
      env: {
        CLAUDECODE: "1",
        ITERM_SESSION_ID: "w0t0p0:second"
      },
      username: "alice",
      parentPid: 9001,
      hostId: "test-host",
      inspector: ancestryInspector
    });

    expect(first!.agent_id).toBe(second!.agent_id);
  });

  test("uses CLAUDE_CODE_SESSION_ID as the stable session id when Claude Code provides it", () => {
    const inspector = fakeInspector({
      9000: { startTime: "Thu Apr 23 14:00:00 2026", command: "bash", ppid: 1 },
      9001: { startTime: "Thu Apr 23 14:05:00 2026", command: "bash", ppid: 1 }
    });

    const first = deriveHarnessCliIdentity({
      env: {
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "shared-session-uuid",
        ITERM_SESSION_ID: "w0t0p0:first"
      },
      username: "alice",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });
    const second = deriveHarnessCliIdentity({
      env: {
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "shared-session-uuid",
        ITERM_SESSION_ID: "w0t0p0:second"
      },
      username: "alice",
      parentPid: 9001,
      hostId: "test-host",
      inspector
    });

    expect(first!.agent_id).toBe(second!.agent_id);
  });

  test("different CLAUDE_CODE_SESSION_ID values produce different agent ids", () => {
    const inspector = fakeInspector({
      9000: { startTime: "Thu Apr 23 14:00:00 2026", command: "bash", ppid: 1 }
    });

    const env = {
      CLAUDECODE: "1",
      ITERM_SESSION_ID: "w0t0p0:same"
    };
    const a = deriveHarnessCliIdentity({
      env: { ...env, CLAUDE_CODE_SESSION_ID: "session-a" },
      username: "alice",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });
    const b = deriveHarnessCliIdentity({
      env: { ...env, CLAUDE_CODE_SESSION_ID: "session-b" },
      username: "alice",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });

    expect(a!.agent_id).not.toBe(b!.agent_id);
  });
});

describe("CLI identity stability", () => {
  test("a second `tt` shell-out from the same codex session reuses the agent_id", () => {
    // Same codex root, two distinct bash subshells with different pids.
    // Anchoring the session id to codex's pid means both `tt` invocations
    // produce the same agent_id.
    const inspector = fakeInspector({
      100: { startTime: "Tue Apr 28 19:00:00 2026", command: "codex", ppid: 1 },
      200: { startTime: "Tue Apr 28 19:35:00 2026", command: "bash", ppid: 100 },
      300: { startTime: "Tue Apr 28 22:12:00 2026", command: "bash", ppid: 100 }
    });
    const env = { CODEX_MANAGED_BY_NPM: "1" };

    const first = deriveHarnessCliIdentity({
      env,
      username: "alice",
      parentPid: 200,
      hostId: "test-host",
      inspector
    });
    const second = deriveHarnessCliIdentity({
      env,
      username: "alice",
      parentPid: 300,
      hostId: "test-host",
      inspector
    });

    expect(first!.agent_id).toBe(second!.agent_id);
  });

});

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

function makeTempWorkspace(): { workspace: string; logPath: string } {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tt-identity-grok-"));
  tempDirs.push(tempRoot);
  const workspace = path.join(tempRoot, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "package.json"), "{}\n");
  return {
    workspace,
    logPath: path.join(tempRoot, "grok-sessions.jsonl")
  };
}
