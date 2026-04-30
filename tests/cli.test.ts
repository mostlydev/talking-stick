import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  checkGuardianLiveness,
  formatRelativeTime,
  parseHandoffJson,
  runCli,
  shouldAutoSyncInstalledSkills,
  shouldUseJson
} from "../src/cli.js";
import {
  deriveHumanCliIdentity,
  readCliSessions,
  resolveCliSessionPath,
  TalkingStickService,
  upsertCliSession
} from "../src/index.js";

const ENV_KEYS = [
  "TT_HARNESS_EXPORT",
  "TT_HARNESS_AGENT_ID",
  "CLAUDECODE",
  "CLAUDE_CODE_EXECPATH",
  "CMUX_CLAUDE_PID",
  "CODEX_MANAGED_BY_NPM",
  "CODEX_THREAD_ID",
  "GEMINI_CLI",
  "OPENCODE",
  "OPENCODE_RUN_ID",
  "OPENCODE_PID",
  "TALKING_STICK_DATA_DIR",
  "TALKING_STICK_DISABLE_SKILL_SYNC"
] as const;

const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]])
);

beforeEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("tt whoami", () => {
  test("defaults to human CLI identity", async () => {
    delete process.env.TT_HARNESS_EXPORT;
    delete process.env.TT_HARNESS_AGENT_ID;
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE_EXECPATH;

    const stdout = await captureStdout(["whoami", "--json"]);
    const result = JSON.parse(stdout) as {
      agent_id: string;
      source: string;
      process_metadata: { session_kind: string };
    };

    expect(result.agent_id).toMatch(/^human:/);
    expect(result.source).toBe("human_cli_default");
    expect(result.process_metadata.session_kind).toBe("human_cli");
  });

  test("uses an explicitly exported harness agent id", async () => {
    process.env.TT_HARNESS_AGENT_ID = "claude:demo1234";
    delete process.env.TT_HARNESS_EXPORT;

    const stdout = await captureStdout(["whoami", "--json"]);
    const result = JSON.parse(stdout) as {
      agent_id: string;
      source: string;
    };

    expect(result.agent_id).toBe("claude:demo1234");
    expect(result.source).toBe("harness_cli_exported_agent_id");
  });

  test("derives harness identity from Claude environment before human fallback", async () => {
    delete process.env.TT_HARNESS_EXPORT;
    process.env.CLAUDECODE = "1";
    delete process.env.TT_HARNESS_AGENT_ID;

    const stdout = await captureStdout(["whoami", "--json"]);
    const result = JSON.parse(stdout) as {
      agent_id: string;
      source: string;
      process_metadata: { session_kind: string };
    };

    expect(result.agent_id).toMatch(/^claude:/);
    expect(result.source).toBe("harness_cli_env_detection");
    expect(result.process_metadata.session_kind).toBe("harness_cli");
  });

  test("reports explicit agent override as the source", async () => {
    const stdout = await captureStdout([
      "whoami",
      "--agent",
      "human:alex",
      "--json"
    ]);
    const result = JSON.parse(stdout) as {
      agent_id: string;
      source: string;
    };

    expect(result.agent_id).toBe("human:alex");
    expect(result.source).toBe("agent_override");
  });
});

describe("shouldUseJson", () => {
  const emptyParsed = {
    name: "wait",
    positionals: [],
    options: new Map<string, string | true>()
  };

  test("returns false by default for human invocation", () => {
    expect(shouldUseJson(emptyParsed, {})).toBe(false);
  });

  test("returns true when --json is set", () => {
    const parsed = {
      ...emptyParsed,
      options: new Map<string, string | true>([["json", true]])
    };
    expect(shouldUseJson(parsed, {})).toBe(true);
  });

  test("returns true when invoked from a harness via TT_HARNESS_EXPORT", () => {
    expect(shouldUseJson(emptyParsed, { TT_HARNESS_EXPORT: "1" })).toBe(true);
  });

  test("returns true when invoked from a detected harness environment", () => {
    expect(shouldUseJson(emptyParsed, { CLAUDECODE: "1" })).toBe(true);
  });

  test("returns true when TT_HARNESS_AGENT_ID is set", () => {
    expect(
      shouldUseJson(emptyParsed, { TT_HARNESS_AGENT_ID: "claude:abc" })
    ).toBe(true);
  });

  test("--text overrides harness auto-JSON", () => {
    const parsed = {
      ...emptyParsed,
      options: new Map<string, string | true>([["text", true]])
    };
    expect(shouldUseJson(parsed, { TT_HARNESS_EXPORT: "1" })).toBe(false);
  });

  test("--json wins over --text when both are set", () => {
    const parsed = {
      ...emptyParsed,
      options: new Map<string, string | true>([
        ["json", true],
        ["text", true]
      ])
    };
    expect(shouldUseJson(parsed, {})).toBe(true);
  });

  test("blank harness env values are ignored", () => {
    expect(shouldUseJson(emptyParsed, { TT_HARNESS_EXPORT: "  " })).toBe(false);
  });

  test("TT_HARNESS_EXPORT only triggers on '1' or 'true' (matches identity)", () => {
    // Identity-disabled values stay in human/text mode.
    expect(shouldUseJson(emptyParsed, { TT_HARNESS_EXPORT: "0" })).toBe(false);
    expect(shouldUseJson(emptyParsed, { TT_HARNESS_EXPORT: "false" })).toBe(false);
    expect(shouldUseJson(emptyParsed, { TT_HARNESS_EXPORT: "no" })).toBe(false);
    expect(shouldUseJson(emptyParsed, { TT_HARNESS_EXPORT: "off" })).toBe(false);
    // Identity-enabled values trigger auto-JSON.
    expect(shouldUseJson(emptyParsed, { TT_HARNESS_EXPORT: "1" })).toBe(true);
    expect(shouldUseJson(emptyParsed, { TT_HARNESS_EXPORT: "true" })).toBe(true);
    expect(shouldUseJson(emptyParsed, { TT_HARNESS_EXPORT: "TRUE" })).toBe(true);
    expect(shouldUseJson(emptyParsed, { TT_HARNESS_EXPORT: "True" })).toBe(true);
  });
});

describe("shouldAutoSyncInstalledSkills", () => {
  const parsed = {
    name: "state",
    positionals: [],
    options: new Map<string, string | true>()
  };

  test("runs for ordinary human CLI commands", () => {
    expect(shouldAutoSyncInstalledSkills(parsed, {})).toBe(true);
  });

  test("skips harness-aware CLI invocations", () => {
    expect(
      shouldAutoSyncInstalledSkills(parsed, {
        TT_HARNESS_AGENT_ID: "codex:harness"
      })
    ).toBe(false);
    expect(
      shouldAutoSyncInstalledSkills(parsed, {
        CLAUDECODE: "1"
      })
    ).toBe(false);
  });

  test("can be disabled by env and skips installer commands", () => {
    expect(
      shouldAutoSyncInstalledSkills(parsed, {
        TALKING_STICK_DISABLE_SKILL_SYNC: "1"
      })
    ).toBe(false);
    expect(
      shouldAutoSyncInstalledSkills({
        ...parsed,
        name: "install"
      }, {})
    ).toBe(false);
    expect(
      shouldAutoSyncInstalledSkills({
        ...parsed,
        name: "install-skill"
      }, {})
    ).toBe(false);
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-04-26T12:00:00.000Z");

  test("renders sub-minute deltas in seconds", () => {
    expect(formatRelativeTime("2026-04-26T11:59:30.000Z", now)).toBe("30s ago");
  });

  test("renders past minutes", () => {
    expect(formatRelativeTime("2026-04-26T11:47:00.000Z", now)).toBe("13m ago");
  });

  test("renders future deadlines", () => {
    expect(formatRelativeTime("2026-04-26T12:14:00.000Z", now)).toBe("in 14m");
  });

  test("renders hours and days", () => {
    expect(formatRelativeTime("2026-04-26T09:00:00.000Z", now)).toBe("3h ago");
    expect(formatRelativeTime("2026-04-23T12:00:00.000Z", now)).toBe("3d ago");
  });

  test("returns em dash for null/undefined", () => {
    expect(formatRelativeTime(null)).toBe("—");
    expect(formatRelativeTime(undefined)).toBe("—");
  });

  test("returns the original string when unparseable", () => {
    expect(formatRelativeTime("not-a-timestamp", now)).toBe("not-a-timestamp");
  });
});

describe("parseHandoffJson", () => {
  test("accepts a minimal valid handoff", () => {
    const result = parseHandoffJson({
      status: "Did the thing.",
      next_action: "Do the next thing."
    });
    expect(result.status).toBe("Did the thing.");
    expect(result.next_action).toBe("Do the next thing.");
  });

  test("preserves optional artifacts/open_questions/do_not fields", () => {
    const input = {
      status: "Status text",
      next_action: "Next action text",
      artifacts: [{ path: "src/cli.ts", role: "review", note: "Check this" }],
      open_questions: ["Should we ship?"],
      do_not: ["Do not push without review"]
    };
    const result = parseHandoffJson(input);
    expect(result.artifacts).toEqual(input.artifacts);
    expect(result.open_questions).toEqual(input.open_questions);
    expect(result.do_not).toEqual(input.do_not);
  });

  test("rejects non-object input", () => {
    expect(() => parseHandoffJson(null)).toThrow(/object/);
    expect(() => parseHandoffJson("a string")).toThrow(/object/);
    expect(() => parseHandoffJson(42)).toThrow(/object/);
    expect(() => parseHandoffJson([])).toThrow(/object/);
  });

  test("rejects missing or empty status", () => {
    expect(() =>
      parseHandoffJson({ next_action: "do it" })
    ).toThrow(/non-empty `status`/);
    expect(() =>
      parseHandoffJson({ status: "  ", next_action: "do it" })
    ).toThrow(/non-empty `status`/);
  });

  test("rejects missing or empty next_action", () => {
    expect(() =>
      parseHandoffJson({ status: "did it" })
    ).toThrow(/non-empty `next_action`/);
    expect(() =>
      parseHandoffJson({ status: "did it", next_action: "" })
    ).toThrow(/non-empty `next_action`/);
  });
});

describe("checkGuardianLiveness", () => {
  test("returns unknown when pid or start time is missing", () => {
    const inspector = {
      inspect: () => {
        throw new Error("inspector must not be consulted");
      }
    };
    expect(
      checkGuardianLiveness(
        { pid: null, process_started_at: "Thu Apr 23 19:22:02 2026" },
        inspector,
        "linux"
      )
    ).toBe("unknown");
    expect(
      checkGuardianLiveness(
        { pid: 1234, process_started_at: null },
        inspector,
        "linux"
      )
    ).toBe("unknown");
    expect(
      checkGuardianLiveness(
        { pid: 1234, process_started_at: "   " },
        inspector,
        "linux"
      )
    ).toBe("unknown");
  });

  test("returns unknown on win32 without consulting the inspector", () => {
    const inspector = {
      inspect: () => {
        throw new Error("inspector must not be consulted");
      }
    };
    expect(
      checkGuardianLiveness(
        { pid: 1234, process_started_at: "whatever" },
        inspector,
        "win32"
      )
    ).toBe("unknown");
  });

  test("returns alive when pid exists and start times match (with whitespace drift)", () => {
    const inspector = {
      inspect: () => ({ startTime: "  Thu Apr 23 19:22:02 2026 " })
    };
    expect(
      checkGuardianLiveness(
        { pid: 1234, process_started_at: "Thu Apr 23 19:22:02 2026" },
        inspector,
        "linux"
      )
    ).toBe("alive");
  });

  test("returns gone when the process is absent (inspect returns null)", () => {
    const inspector = {
      inspect: () => null
    };
    expect(
      checkGuardianLiveness(
        { pid: 1234, process_started_at: "Thu Apr 23 19:22:02 2026" },
        inspector,
        "linux"
      )
    ).toBe("gone");
  });

  test("returns gone when inspect returns a record without a start time", () => {
    const inspector = {
      inspect: () => ({ startTime: null })
    };
    expect(
      checkGuardianLiveness(
        { pid: 1234, process_started_at: "Thu Apr 23 19:22:02 2026" },
        inspector,
        "linux"
      )
    ).toBe("gone");
  });

  test("returns unknown when inspector signals cache miss (undefined)", () => {
    const inspector = {
      inspect: () => undefined
    };
    expect(
      checkGuardianLiveness(
        { pid: 1234, process_started_at: "Thu Apr 23 19:22:02 2026" },
        inspector,
        "linux"
      )
    ).toBe("unknown");
  });

  test("returns unknown when start times differ (pid may be reused, do not kill)", () => {
    const inspector = {
      inspect: () => ({ startTime: "Fri Apr 24 08:00:00 2026" })
    };
    expect(
      checkGuardianLiveness(
        { pid: 1234, process_started_at: "Thu Apr 23 19:22:02 2026" },
        inspector,
        "linux"
      )
    ).toBe("unknown");
  });
});

describe("tt turn commands", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tt pass treats its first positional as the path", async () => {
    const { project } = setupIsolatedCli(tempDirs);

    await seedCliLease(project, "human:owner", ["human:next"]);

    const passOut = await captureStdout([
      "pass",
      project,
      "--agent",
      "human:owner",
      "--status",
      "Owner is passing.",
      "--next-action",
      "Next agent should continue.",
      "--json"
    ]);
    const passed = JSON.parse(passOut) as {
      status: string;
      reserved_for: string | null;
    };

    expect(passed.status).toBe("released");
    expect(passed.reserved_for).toBe("human:next");
  });

  test("tt assign next resolves the fair active recipient", async () => {
    const { project } = setupIsolatedCli(tempDirs);

    await seedCliLease(project, "human:owner", ["human:next"]);

    const assignOut = await captureStdout([
      "assign",
      "next",
      project,
      "--agent",
      "human:owner",
      "--status",
      "Assigning explicitly.",
      "--next-action",
      "Take the assigned turn.",
      "--json"
    ]);
    const assigned = JSON.parse(assignOut) as {
      status: string;
      reserved_for: string;
    };

    expect(assigned.status).toBe("passed");
    expect(assigned.reserved_for).toBe("human:next");
  });

  test("human tt take can override a reserved turn without a reason", async () => {
    const { project } = setupIsolatedCli(tempDirs);

    await captureStdout(["join", project, "--agent", "human:owner"]);
    await captureStdout(["join", project, "--agent", "human:reserved"]);
    await captureStdout(["take", project, "--agent", "human:owner", "--json"]);
    await captureStdout([
      "release",
      project,
      "--agent",
      "human:owner",
      "--status",
      "Reserved for another user.",
      "--next-action",
      "Operator will override.",
      "--json"
    ]);

    const takeOut = await captureStdout([
      "take",
      project,
      "--agent",
      "human:operator",
      "--json"
    ]);
    const taken = JSON.parse(takeOut) as {
      status: string;
      reason: string;
      revoked_agent_id: string | null;
    };

    expect(taken.status).toBe("your_turn");
    expect(taken.reason).toBe("operator_override");
    expect(taken.revoked_agent_id).toBe("human:reserved");

    await captureStdout([
      "release",
      project,
      "--agent",
      "human:operator",
      "--status",
      "Operator is done.",
      "--next-action",
      "Continue normally.",
      "--json"
    ]);
  });

  test("harness tt take still requires a reason unless operator-requested", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    process.env.TT_HARNESS_AGENT_ID = "codex:harness";

    await expect(captureStdout(["take", project])).rejects.toThrow(
      /Missing required option --reason/
    );
  });
});

describe("tt room commands", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tt leave removes this identity and deletes the last-member room", async () => {
    const { project } = setupIsolatedCli(tempDirs);

    await captureStdout(["join", project, "--agent", "human:leaver"]);
    const leaveOut = await captureStdout([
      "leave",
      project,
      "--agent",
      "human:leaver",
      "--json"
    ]);
    const left = JSON.parse(leaveOut) as {
      status: string;
      remaining_members: number;
    };

    expect(left.status).toBe("room_deleted");
    expect(left.remaining_members).toBe(0);
    expect(readCliSessions(resolveCliSessionPath())).toEqual([]);

    const listOut = await captureStdout(["list", project]);
    expect(listOut.trim()).toBe("No rooms found.");
  });

  test("tt join --force-new prints a warning when the exact path already has a room", async () => {
    const { project } = setupIsolatedCli(tempDirs);

    await captureStdout(["join", project, "--agent", "human:first"]);
    const joinOut = await captureStdout([
      "join",
      project,
      "--agent",
      "human:second",
      "--force-new"
    ]);

    expect(joinOut).toContain(`Joined ${project} as human:second`);
    expect(joinOut).toContain("Warning: force_new had no effect");

    const listOut = await captureStdout(["list", project]);
    expect(listOut.split("\n").filter(Boolean)).toHaveLength(1);
  });
});

describe("tt notes", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tt notes add + tt notes list round-trip through the CLI", async () => {
    const { project } = setupIsolatedCli(tempDirs);

    await captureStdout([
      "join",
      project,
      "--agent",
      "human:notes-test"
    ]);

    const addOut = await captureStdout([
      "notes",
      "add",
      "Heads up about service.ts:1400",
      "--agent",
      "human:notes-test",
      "--path",
      project,
      "--json"
    ]);
    const added = JSON.parse(addOut);
    expect(added.author_agent_id).toBe("human:notes-test");
    expect(added.turn_id).toBeNull();
    expect(added.note_id).toMatch(/^[0-9a-f-]+$/);

    const listOut = await captureStdout([
      "notes",
      "list",
      "--agent",
      "human:notes-test",
      "--path",
      project,
      "--json"
    ]);
    const listed = JSON.parse(listOut);
    expect(listed.notes).toHaveLength(1);
    expect(listed.notes[0]).toMatchObject({
      note_id: added.note_id,
      author_agent_id: "human:notes-test",
      body: "Heads up about service.ts:1400",
      turn_id: null
    });
  });

  test("tt notes list text mode shows the short note id and first line", async () => {
    const { project } = setupIsolatedCli(tempDirs);

    await captureStdout([
      "join",
      project,
      "--agent",
      "human:notes-text"
    ]);

    await captureStdout([
      "notes",
      "add",
      "first line only\nsecond line should be hidden in text mode",
      "--agent",
      "human:notes-text",
      "--path",
      project,
      "--json"
    ]);

    const listOut = await captureStdout([
      "notes",
      "list",
      "--agent",
      "human:notes-text",
      "--path",
      project
    ]);

    expect(listOut).toContain("human:notes-text");
    expect(listOut).toContain("first line only");
    expect(listOut).not.toContain("second line should be hidden");
  });

  test("tt notes add rejects empty body", async () => {
    const { project } = setupIsolatedCli(tempDirs);

    await captureStdout([
      "join",
      project,
      "--agent",
      "human:notes-empty"
    ]);

    await expect(
      captureStdout([
        "notes",
        "add",
        "--agent",
        "human:notes-empty",
        "--path",
        project,
        "   "
      ])
    ).rejects.toThrow(/Note body is required/);
  });

  test("tt notes list text mode renders bulleted entries with relative time and scope", async () => {
    const { project } = setupIsolatedCli(tempDirs);

    await captureStdout(["join", project, "--agent", "human:notes-fmt"]);

    await captureStdout([
      "notes",
      "add",
      "room note body that is short enough to fit on one line",
      "--agent",
      "human:notes-fmt",
      "--path",
      project,
      "--json"
    ]);

    const listOut = await captureStdout([
      "notes",
      "list",
      "--agent",
      "human:notes-fmt",
      "--path",
      project
    ]);

    expect(listOut).toMatch(/^1 note in this room:/);
    expect(listOut).toContain("- ");
    expect(listOut).toContain("human:notes-fmt");
    expect(listOut).toContain("room-scoped");
    expect(listOut).toMatch(/(ago|in \d)/);
  });

  test("tt state text mode shows owner, members, and 'you' marker", async () => {
    const { project } = setupIsolatedCli(tempDirs);

    await captureStdout(["join", project, "--agent", "human:state-test"]);

    const stateOut = await captureStdout([
      "state",
      project,
      "--agent",
      "human:state-test"
    ]);

    expect(stateOut).toContain(`Room: ${project}`);
    expect(stateOut).toContain("Members:");
    expect(stateOut).toContain("human:state-test");
    expect(stateOut).toContain("← you");
  });

  test("tt events text mode groups events by turn", async () => {
    const { project } = setupIsolatedCli(tempDirs);

    await captureStdout(["join", project, "--agent", "human:events-test"]);
    // No events yet — empty case rendering.
    const empty = await captureStdout([
      "events",
      project,
      "--agent",
      "human:events-test"
    ]);
    expect(empty.trim()).toBe("No events.");
  });

  test("--json forces JSON for tt state regardless of mode", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    await captureStdout(["join", project, "--agent", "human:json-test"]);

    const out = await captureStdout([
      "state",
      project,
      "--agent",
      "human:json-test",
      "--json"
    ]);
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty("room");
    expect(parsed).toHaveProperty("members");
  });

  test("TT_HARNESS_EXPORT auto-switches state to JSON; --text overrides", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    await captureStdout(["join", project, "--agent", "human:auto-test"]);

    process.env.TT_HARNESS_EXPORT = "1";
    try {
      const auto = await captureStdout([
        "state",
        project,
        "--agent",
        "human:auto-test"
      ]);
      // Should parse as JSON.
      const parsed = JSON.parse(auto);
      expect(parsed).toHaveProperty("room");

      const forcedText = await captureStdout([
        "state",
        project,
        "--agent",
        "human:auto-test",
        "--text"
      ]);
      expect(forcedText).toContain("Room:");
      expect(() => JSON.parse(forcedText)).toThrow();
    } finally {
      delete process.env.TT_HARNESS_EXPORT;
    }
  });

  test("tt self-update --print emits the inferred command without running it", async () => {
    const out = await captureStdout([
      "self-update",
      "--print",
      "--manager",
      "pnpm"
    ]);
    expect(out.trim()).toBe("pnpm install -g talking-stick@latest");
  });

  test("tt self-update --manager rejects unknown values", async () => {
    await expect(
      captureStdout(["self-update", "--print", "--manager", "winget"])
    ).rejects.toThrow(/--manager must be one of/);
  });

  test("tt install --print includes MCP and skill actions", async () => {
    const out = await captureStdout(["install", "codex", "--print"]);

    expect(out).toContain("[codex] codex mcp add talking-stick -- tt mcp");
    expect(out).toContain("[codex] link ");
    expect(out).toContain(".codex/skills/talking-stick");
  });

  test("tt install --copy --print plans a copied skill", async () => {
    const out = await captureStdout([
      "install",
      "codex",
      "--print",
      "--copy"
    ]);

    expect(out).toContain("[codex] codex mcp add talking-stick -- tt mcp");
    expect(out).toContain("[codex] copy ");
    expect(out).toContain(".codex/skills/talking-stick");
  });

  test("tt install rejects conflicting skill link modes", async () => {
    await expect(
      captureStdout(["install", "codex", "--print", "--copy", "--link"])
    ).rejects.toThrow(/Pass only one of --copy or --link/);
  });

  test("tt uninstall --print includes skill removal", async () => {
    const out = await captureStdout(["uninstall", "codex", "--print"]);

    expect(out).toContain("[codex] remove ");
    expect(out).toContain(".codex/skills/talking-stick");
  });

  test("tt notes with unknown subcommand surfaces an error", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    await captureStdout([
      "join",
      project,
      "--agent",
      "human:notes-unknown"
    ]);
    await expect(
      captureStdout([
        "notes",
        "resolve",
        "--agent",
        "human:notes-unknown",
        "--path",
        project
      ])
    ).rejects.toThrow(/Unknown notes subcommand: resolve/);
  });
});

describe("tt msg", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tt msg send resolves an active display name recipient", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    const roomId = seedCliRoomMembers(project, [
      { agent_id: "human:sender", display_name: "sender" },
      { agent_id: "codex:target", display_name: "codex" }
    ]);

    const sendOut = await captureStdout([
      "msg",
      "send",
      "codex",
      "hello from sender",
      "--agent",
      "human:sender",
      "--path",
      project,
      "--json"
    ]);
    const sent = JSON.parse(sendOut) as { event_seq: number };
    expect(sent.event_seq).toBeGreaterThan(0);

    const service = new TalkingStickService();
    try {
      const events = service.getRoomEvents({ room_id: roomId });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event_type: "message_sent",
        from_agent_id: "human:sender",
        to_agent_id: "codex:target",
        payload: {
          body: "hello from sender",
          delivery_hint: "normal"
        }
      });
    } finally {
      service.close();
    }
  });

  test("tt msg send accepts full agent ids and broadcasts to room", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    const roomId = seedCliRoomMembers(project, [
      { agent_id: "human:sender", display_name: "sender" },
      { agent_id: "codex:target", display_name: "codex" }
    ]);

    await captureStdout([
      "msg",
      "send",
      "codex:target",
      "direct",
      "--agent",
      "human:sender",
      "--path",
      project,
      "--json"
    ]);
    await captureStdout([
      "msg",
      "send",
      "room",
      "broadcast",
      "--agent",
      "human:sender",
      "--path",
      project,
      "--json"
    ]);

    const service = new TalkingStickService();
    try {
      const events = service.getRoomEvents({ room_id: roomId });
      expect(events.map((event) => event.to_agent_id)).toEqual([
        "codex:target",
        null
      ]);
      expect(events.map((event) => event.payload?.body)).toEqual([
        "direct",
        "broadcast"
      ]);
    } finally {
      service.close();
    }
  });

  test("tt msg send repairs --interrupt before a one-token body", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    const roomId = seedCliRoomMembers(project, [
      { agent_id: "human:sender", display_name: "sender" },
      { agent_id: "codex:target", display_name: "codex" }
    ]);

    await captureStdout([
      "msg",
      "send",
      "codex",
      "--interrupt",
      "body",
      "--agent",
      "human:sender",
      "--path",
      project,
      "--json"
    ]);

    const service = new TalkingStickService();
    try {
      const events = service.getRoomEvents({ room_id: roomId });
      expect(events[0]).toMatchObject({
        to_agent_id: "codex:target",
        payload: {
          body: "body",
          delivery_hint: "interrupt"
        }
      });
    } finally {
      service.close();
    }
  });

  test("tt msg send repairs --interrupt before a multi-word body", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    const roomId = seedCliRoomMembers(project, [
      { agent_id: "human:sender", display_name: "sender" },
      { agent_id: "codex:target", display_name: "codex" }
    ]);

    await captureStdout([
      "msg",
      "send",
      "codex",
      "--interrupt",
      "the body has spaces",
      "--agent",
      "human:sender",
      "--path",
      project,
      "--json"
    ]);

    const service = new TalkingStickService();
    try {
      const events = service.getRoomEvents({ room_id: roomId });
      expect(events[0]).toMatchObject({
        to_agent_id: "codex:target",
        payload: {
          body: "the body has spaces",
          delivery_hint: "interrupt"
        }
      });
    } finally {
      service.close();
    }
  });

  test("tt msg send reports unknown and ambiguous display recipients", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    seedCliRoomMembers(project, [
      { agent_id: "human:sender", display_name: "sender" },
      { agent_id: "codex:first", display_name: "codex" },
      { agent_id: "codex:second", display_name: "codex" }
    ]);

    await expect(
      captureStdout([
        "msg",
        "send",
        "gemini",
        "hello",
        "--agent",
        "human:sender",
        "--path",
        project
      ])
    ).rejects.toThrow(/No active room member matches 'gemini'/);

    await expect(
      captureStdout([
        "msg",
        "send",
        "codex",
        "hello",
        "--agent",
        "human:sender",
        "--path",
        project
      ])
    ).rejects.toMatchObject({ code: "ambiguous_recipient" });
  });

  test("tt msg send rejects a missing body", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    seedCliRoomMembers(project, [
      { agent_id: "human:sender", display_name: "sender" },
      { agent_id: "codex:target", display_name: "codex" }
    ]);

    await expect(
      captureStdout([
        "msg",
        "send",
        "codex",
        "--agent",
        "human:sender",
        "--path",
        project
      ])
    ).rejects.toThrow(/Message body is required/);
  });

  test("tt msg recv one-shot returns messages for self", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    const roomId = seedCliRoomMembers(project, [
      { agent_id: "human:sender", display_name: "sender" },
      { agent_id: "human:receiver", display_name: "receiver" }
    ]);
    sendCliTestMessage(roomId, "human:sender", "human:receiver", "direct");

    const recvOut = await captureStdout([
      "msg",
      "recv",
      "--agent",
      "human:receiver",
      "--path",
      project,
      "--json"
    ]);
    const events = parseJsonLines(recvOut);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      from_agent_id: "human:sender",
      to_agent_id: "human:receiver",
      payload: { body: "direct" }
    });
  });

  test("tt msg recv --wait exits after the next matching message", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    const roomId = seedCliRoomMembers(project, [
      { agent_id: "human:sender", display_name: "sender" },
      { agent_id: "human:receiver", display_name: "receiver" }
    ]);

    const recvPromise = captureStdout([
      "msg",
      "recv",
      "--wait",
      "--timeout",
      "2s",
      "--agent",
      "human:receiver",
      "--path",
      project,
      "--json"
    ]);
    setTimeout(() => {
      sendCliTestMessage(roomId, "human:sender", "human:receiver", "wake");
    }, 25);

    const events = parseJsonLines(await recvPromise);
    expect(events).toHaveLength(1);
    expect(events[0].payload.body).toBe("wake");
  });

  test("tt msg recv --wait --from filters by sender server-side", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    const roomId = seedCliRoomMembers(project, [
      { agent_id: "human:receiver", display_name: "receiver" },
      { agent_id: "codex:sender", display_name: "codex" },
      { agent_id: "gemini:sender", display_name: "gemini" }
    ]);

    const recvPromise = captureStdout([
      "msg",
      "recv",
      "--wait",
      "--from",
      "codex",
      "--timeout",
      "2s",
      "--agent",
      "human:receiver",
      "--path",
      project,
      "--json"
    ]);
    setTimeout(() => {
      sendCliTestMessage(roomId, "gemini:sender", "human:receiver", "ignore");
      sendCliTestMessage(roomId, "codex:sender", "human:receiver", "include");
    }, 25);

    const events = parseJsonLines(await recvPromise);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      from_agent_id: "codex:sender",
      payload: { body: "include" }
    });
  });

  test("tt msg recv --wait starts at the current tail by default", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    const roomId = seedCliRoomMembers(project, [
      { agent_id: "human:sender", display_name: "sender" },
      { agent_id: "human:receiver", display_name: "receiver" }
    ]);
    sendCliTestMessage(roomId, "human:sender", "human:receiver", "old");

    const recvOut = await captureStdout([
      "msg",
      "recv",
      "--wait",
      "--timeout",
      "20ms",
      "--agent",
      "human:receiver",
      "--path",
      project,
      "--json"
    ]);

    expect(recvOut).toBe("");
  });

  test("tt events --wait filters event types and emits JSON lines", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    const roomId = seedCliRoomMembers(project, [
      { agent_id: "human:sender", display_name: "sender" },
      { agent_id: "human:observer", display_name: "observer" }
    ]);

    const eventsPromise = captureStdout([
      "events",
      project,
      "--wait",
      "--event",
      "message_sent",
      "--target",
      "any",
      "--timeout",
      "2s",
      "--agent",
      "human:observer",
      "--json"
    ]);
    setTimeout(() => {
      sendCliTestMessage(roomId, "human:sender", null, "broadcast");
    }, 25);

    const events = parseJsonLines(await eventsPromise);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: "message_sent",
      to_agent_id: null,
      payload: { body: "broadcast" }
    });
  });
});

function setupIsolatedCli(registry: string[]): { dataDir: string; project: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-cli-"));
  registry.push(dataDir);
  process.env.TALKING_STICK_DATA_DIR = dataDir;

  const project = path.join(dataDir, "project");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "package.json"), "{}\n");
  const resolvedProject = fs.realpathSync.native(project);

  return { dataDir, project: resolvedProject };
}

async function seedCliLease(
  project: string,
  ownerAgentId: string,
  otherAgentIds: string[] = []
): Promise<void> {
  const service = new TalkingStickService();
  try {
    const ownerIdentity = deriveHumanCliIdentity({
      agentId: ownerAgentId,
      displayName: ownerAgentId.replace(/^[^:]+:/, "")
    });
    const joined = service.joinPath({
      agent_id: ownerIdentity.agent_id,
      context_path: project,
      process_metadata: ownerIdentity.process_metadata
    });

    for (const agentId of otherAgentIds) {
      const identity = deriveHumanCliIdentity({
        agentId,
        displayName: agentId.replace(/^[^:]+:/, "")
      });
      service.joinPath({
        agent_id: identity.agent_id,
        context_path: project,
        process_metadata: identity.process_metadata
      });
    }

    const turn = await service.waitForTurn({
      agent_id: ownerIdentity.agent_id,
      room_id: joined.room_id,
      max_wait_ms: 0
    });
    expect(turn.status).toBe("your_turn");
    if (turn.status !== "your_turn") {
      throw new Error(`Expected seeded owner turn, got ${turn.status}`);
    }

    upsertCliSession(resolveCliSessionPath(), {
      agent_id: ownerIdentity.agent_id,
      room_id: joined.room_id,
      canonical_path: joined.canonical_path,
      workspace_root: joined.workspace_root,
      lease_id: turn.lease_id,
      turn_id: turn.turn_id,
      guardian_pid: null,
      guardian_process_started_at: null,
      updated_at: new Date().toISOString()
    });
  } finally {
    service.close();
  }
}

interface SeedCliMember {
  agent_id: string;
  display_name: string;
}

function seedCliRoomMembers(project: string, members: SeedCliMember[]): string {
  const service = new TalkingStickService();
  try {
    let roomId: string | null = null;
    for (const member of members) {
      const joined = service.joinPath({
        agent_id: member.agent_id,
        context_path: project,
        process_metadata: {
          session_kind: member.agent_id.startsWith("human:")
            ? "human_cli"
            : "mcp_harness",
          display_name: member.display_name
        }
      });
      roomId = joined.room_id;
    }
    if (!roomId) {
      throw new Error("seedCliRoomMembers requires at least one member.");
    }
    return roomId;
  } finally {
    service.close();
  }
}

function sendCliTestMessage(
  roomId: string,
  fromAgentId: string,
  toAgentId: string | null,
  body: string
): void {
  const service = new TalkingStickService();
  try {
    service.sendMessage({
      agent_id: fromAgentId,
      room_id: roomId,
      to_agent_id: toAgentId,
      body
    });
  } finally {
    service.close();
  }
}

function parseJsonLines(output: string): any[] {
  return output
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

async function captureStdout(argv: string[]): Promise<string> {
  let stdout = "";
  const previousSkillSync = process.env.TALKING_STICK_DISABLE_SKILL_SYNC;
  process.env.TALKING_STICK_DISABLE_SKILL_SYNC = "1";
  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    }) as typeof process.stdout.write);
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((() => true) as typeof process.stderr.write);

  try {
    await runCli(argv);
  } finally {
    if (previousSkillSync === undefined) {
      delete process.env.TALKING_STICK_DISABLE_SKILL_SYNC;
    } else {
      process.env.TALKING_STICK_DISABLE_SKILL_SYNC = previousSkillSync;
    }
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }

  return stdout;
}
