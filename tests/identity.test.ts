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
      username: "wojtek",
      pid: 3210,
      hostId: "test-host",
      inspector
    });

    expect(identity.agent_id).toBe("human:wojtek");
    expect(identity.process_metadata).toEqual({
      host_id: null,
      pid: null,
      process_started_at: null,
      session_kind: "human_cli",
      display_name: "wojtek"
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
      username: "wojtek",
      pid: 3210,
      hostId: "test-host",
      inspector,
      sessionKind: "human_guardian"
    });

    expect(identity.agent_id).toBe("human:wojtek");
    expect(identity.process_metadata).toEqual({
      host_id: "test-host",
      pid: 3210,
      process_started_at: "Thu Apr 23 12:00:00 2026",
      session_kind: "human_guardian",
      display_name: "wojtek"
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
    9000: { startTime: "Thu Apr 23 14:00:00 2026", command: "claude" }
  });

  test("returns null when no harness env markers are set", () => {
    expect(
      deriveHarnessCliIdentity({
        env: {},
        username: "wojtek",
        parentPid: 9000,
        hostId: "test-host",
        inspector
      })
    ).toBeNull();
  });

  test("detects Claude Code via CLAUDECODE=1", () => {
    const identity = deriveHarnessCliIdentity({
      env: { CLAUDECODE: "1", CLAUDE_CODE_EXECPATH: "/opt/claude/2.1.118" },
      username: "wojtek",
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

  test("detects Codex and prefers CODEX_THREAD_ID for stable identity across invocations", () => {
    const first = deriveHarnessCliIdentity({
      env: { CODEX_MANAGED_BY_NPM: "1", CODEX_THREAD_ID: "019dbc04-0695-77c0-8e59-2220fadcb7fb" },
      username: "wojtek",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });
    const second = deriveHarnessCliIdentity({
      env: { CODEX_MANAGED_BY_NPM: "1", CODEX_THREAD_ID: "019dbc04-0695-77c0-8e59-2220fadcb7fb" },
      username: "wojtek",
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
      username: "wojtek",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });
    expect(identity!.agent_id).toMatch(/^codex:[0-9a-f]{8}$/);
  });

  test("detects Gemini via GEMINI_CLI=1 and falls back to PID-based identity", () => {
    const identity = deriveHarnessCliIdentity({
      env: { GEMINI_CLI: "1" },
      username: "wojtek",
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
      env: { OPENCODE: "1", OPENCODE_RUN_ID: "run-abc", OPENCODE_PID: "12345" },
      username: "wojtek",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });
    const second = deriveHarnessCliIdentity({
      env: { OPENCODE: "1", OPENCODE_RUN_ID: "run-abc", OPENCODE_PID: "99999" },
      username: "wojtek",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });
    expect(first!.agent_id).toMatch(/^opencode:[0-9a-f]{8}$/);
    expect(first!.agent_id).toBe(second!.agent_id);
  });

  test("does not collide identities across harnesses with the same sessionId", () => {
    const codexIdentity = deriveHarnessCliIdentity({
      env: { CODEX_THREAD_ID: "shared" },
      username: "wojtek",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });
    const opencodeIdentity = deriveHarnessCliIdentity({
      env: { OPENCODE: "1", OPENCODE_RUN_ID: "shared" },
      username: "wojtek",
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
      env: { CLAUDECODE: "1" },
      inspector
    });
    expect(identity!.agent_id).toBe("claude:forced-id");
  });

  test("uses a terminal-emulator session id as sessionId fallback for Gemini", () => {
    const identity = deriveHarnessCliIdentity({
      env: { GEMINI_CLI: "1", ITERM_SESSION_ID: "w0t0p0:ABCDEF" },
      username: "wojtek",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });
    expect(identity!.agent_id).toMatch(/^gemini:[0-9a-f]{8}$/);
  });

  test("terminal-emulator fallback keeps identity stable across invocations in the same tab", () => {
    const a = deriveHarnessCliIdentity({
      env: { GEMINI_CLI: "1", CMUX_TAB_ID: "tab-abc" },
      username: "wojtek",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });
    const b = deriveHarnessCliIdentity({
      env: { GEMINI_CLI: "1", CMUX_TAB_ID: "tab-abc" },
      username: "wojtek",
      parentPid: 9001,
      hostId: "test-host",
      inspector
    });
    expect(a!.agent_id).toBe(b!.agent_id);
  });

  test("different terminal tabs produce different identities within the same harness", () => {
    const a = deriveHarnessCliIdentity({
      env: { GEMINI_CLI: "1", CMUX_TAB_ID: "tab-one" },
      username: "wojtek",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });
    const b = deriveHarnessCliIdentity({
      env: { GEMINI_CLI: "1", CMUX_TAB_ID: "tab-two" },
      username: "wojtek",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });
    expect(a!.agent_id).not.toBe(b!.agent_id);
  });
});

describe("CLI and MCP identity unification", () => {
  test("produces the same agent_id whether reached through deriveHarnessCliIdentity or deriveMcpHarnessIdentity", () => {
    const inspector = fakeInspector({
      42: { startTime: "Thu Apr 23 14:00:00 2026", command: "claude --mcp-worker" },
      9000: { startTime: "Thu Apr 23 14:00:00 2026", command: "claude" }
    });
    const env = {
      CLAUDECODE: "1",
      CLAUDE_CODE_EXECPATH: "/opt/claude/2.1.118"
    };

    const cliIdentity = deriveHarnessCliIdentity({
      env,
      username: "wojtek",
      parentPid: 9000,
      hostId: "test-host",
      inspector
    });

    const mcpIdentity = deriveMcpHarnessIdentity({
      env,
      username: "wojtek",
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
      username: "wojtek",
      parentPid: 42,
      hostId: "test-host",
      inspector
    });
    expect(mcpIdentity.agent_id).toMatch(/^some-other-harness:[0-9a-f]{8}$/);
    expect(mcpIdentity.process_metadata.display_name).toBe("some-other-harness");
  });
});

function fakeInspector(
  processes: Record<number, { startTime: string | null; command: string | null }>
): ProcessInspector {
  return {
    inspect(pid) {
      const process = processes[pid];
      if (!process) {
        return null;
      }

      return {
        pid,
        startTime: process.startTime,
        command: process.command
      };
    }
  };
}
