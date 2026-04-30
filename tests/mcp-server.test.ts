import { describe, expect, test } from "vitest";
import { createConnectionIdentityResolver } from "../src/mcp-server.js";
import type { ProcessInspector } from "../src/index.js";

describe("createConnectionIdentityResolver", () => {
  test("memoizes derived identity per session and re-derives on override", () => {
    let inspectCalls = 0;
    const inspector: ProcessInspector = {
      inspect(pid) {
        inspectCalls += 1;
        return {
          pid,
          ppid: 1,
          startTime: "Thu Apr 23 12:15:00 2026",
          command: "codex --mcp-worker"
        };
      }
    };

    const resolveIdentity = createConnectionIdentityResolver({ inspector });

    const first = resolveIdentity("session-a");
    const callsAfterFirst = inspectCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = resolveIdentity("session-a");
    expect(second).toEqual(first);
    expect(inspectCalls).toBe(callsAfterFirst);

    const overridden = resolveIdentity("session-a", "codex:debug");
    expect(overridden.agent_id).toBe("codex:debug");
    expect(inspectCalls).toBeGreaterThan(callsAfterFirst);
    const callsAfterOverride = inspectCalls;

    const overriddenAgain = resolveIdentity("session-a");
    expect(overriddenAgain).toEqual(overridden);
    expect(inspectCalls).toBe(callsAfterOverride);

    resolveIdentity("session-b");
    expect(inspectCalls).toBeGreaterThan(callsAfterOverride);
  });
});
