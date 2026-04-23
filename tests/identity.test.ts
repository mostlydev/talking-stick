import { describe, expect, test } from "vitest";
import {
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
      parentPid: 4242,
      sessionId: "stdio-session",
      hostId: "test-host",
      inspector
    });
    const second = deriveMcpHarnessIdentity({
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
