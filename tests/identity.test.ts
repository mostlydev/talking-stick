import { describe, expect, test } from "vitest";
import {
  deriveHarnessCliIdentity,
  deriveHumanCliIdentity,
  deriveMcpHarnessIdentity,
  type ProcessInspector
} from "../src/index.js";

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

  test("derives an MCP harness identity from the spawning parent process", () => {
    const inspector = fakeInspector({
      4242: {
        startTime: "Thu Apr 23 12:15:00 2026",
        command: "codex --mcp-worker"
      }
    });

    const first = deriveMcpHarnessIdentity({
      env: {},
      parentPid: 4242,
      sessionId: "stdio-session",
      hostId: "test-host",
      inspector
    });
    const second = deriveMcpHarnessIdentity({
      env: {},
      parentPid: 4242,
      sessionId: "stdio-session",
      hostId: "test-host",
      inspector
    });

    expect(first.agent_id).toMatch(/^codex:[0-9a-f]{8}$/);
    expect(first.agent_id).toBe(second.agent_id);
    expect(first.process_metadata).toEqual({
      host_id: "test-host",
      pid: 4242,
      process_started_at: "Thu Apr 23 12:15:00 2026",
      session_kind: "mcp_harness",
      display_name: "codex"
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
      display_name: "claude"
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
});

describe("CLI and MCP identity unification", () => {
  test("produces the same agent_id for harnesses that expose a session id", () => {
    const inspector = fakeInspector({
      42: { startTime: "Thu Apr 23 14:00:00 2026", command: "codex --mcp-worker" },
      9000: { startTime: "Thu Apr 23 14:00:00 2026", command: "codex" }
    });
    const env = {
      CODEX_THREAD_ID: "thread-abc"
    };

    const cliIdentity = deriveHarnessCliIdentity({
      env,
      username: "alice",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });

    const mcpIdentity = deriveMcpHarnessIdentity({
      env,
      username: "alice",
      parentPid: 42,
      hostId: "test-host",
      inspector
    });

    expect(cliIdentity!.agent_id).toBe(mcpIdentity.agent_id);
    expect(cliIdentity!.process_metadata.session_kind).toBe("harness_cli");
    expect(mcpIdentity.process_metadata.session_kind).toBe("mcp_harness");
  });

  test("MCP path falls back to ancestry-based id when no harness env is set (backwards compat)", () => {
    const inspector = fakeInspector({
      42: { startTime: "Thu Apr 23 14:15:00 2026", command: "some-other-harness --mcp" }
    });
    const mcpIdentity = deriveMcpHarnessIdentity({
      env: {},
      username: "alice",
      parentPid: 42,
      hostId: "test-host",
      inspector
    });
    expect(mcpIdentity.agent_id).toMatch(/^some-other-harness:[0-9a-f]{8}$/);
    expect(mcpIdentity.process_metadata.display_name).toBe("some-other-harness");
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
