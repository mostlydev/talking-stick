import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runStartupMaintenance } from "../src/cli/startup-maintenance.js";
import {
  checkGuardianLiveness,
  COORDINATION_PROMPT,
  formatRelativeTime,
  parseHandoffJson,
  prepareJsonResult,
  runCli,
  shouldAutoSyncInstalledSkills,
  shouldUseJson,
  withCoordinationPrompt
} from "../src/cli.js";
import {
  deriveHumanCliIdentity,
  getCurrentProcessStartedAt,
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
  "CMUX_AGENT_LAUNCH_KIND",
  "CMUX_AGENT_LAUNCH_EXECUTABLE",
  "CODEX_MANAGED_BY_NPM",
  "CODEX_THREAD_ID",
  "GEMINI_CLI",
  "GROK_HOME",
  "GROK_SESSION_ID",
  "GROK_WORKSPACE_ROOT",
  "OPENCODE",
  "OPENCODE_RUN_ID",
  "OPENCODE_PID",
  "CLAUDE_PROJECT_DIR",
  "ANTIGRAVITY_AGENT",
  "ANTIGRAVITY_CONVERSATION_ID",
  "ANTIGRAVITY_TRAJECTORY_ID",
  "TALKING_STICK_DATA_DIR",
  "SKILLER_BIN",
  "TALKING_STICK_DISABLE_SKILLER",
  "TALKING_STICK_USE_SKILLER",
  "TALKING_STICK_REQUIRE_SKILLER",
  "TALKING_STICK_SKILLER_MIN_VERSION",
  "TALKING_STICK_DISABLE_SKILL_SYNC",
  "VISUAL",
  "EDITOR",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_DATA_HOME"
] as const;

const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]])
);

beforeEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  process.env.TALKING_STICK_DISABLE_SKILLER = "1";
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
    expect(shouldUseJson(emptyParsed, { CMUX_AGENT_LAUNCH_KIND: "grok" })).toBe(true);
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

describe("JSON error output", () => {
  test("plain CLI errors are structured in JSON mode", async () => {
    const processState = spawnCliProcess(["unknown", "--json"]);
    const close = await waitForProcessClose(processState.child);

    expect(close.code).toBe(1);
    expect(processState.stdout()).toBe("");
    expect(JSON.parse(processState.stderr())).toEqual({
      error: "cli_error",
      message: "Unknown command: unknown"
    });
  });
});

describe("withCoordinationPrompt", () => {
  test("adds the short reminder to common command objects", () => {
    const prompted = withCoordinationPrompt(
      {
        name: "wait",
        positionals: [],
        options: new Map<string, string | true>()
      },
      { status: "not_yet" }
    );

    expect(prompted).toMatchObject({
      status: "not_yet",
      coordination_prompt: COORDINATION_PROMPT
    });
  });

  test("leaves event-stream style arrays unwrapped", () => {
    const events = [{ event_seq: 1, event_type: "message_sent" }];

    expect(
      withCoordinationPrompt(
        {
          name: "events",
          positionals: [],
          options: new Map<string, string | true>()
        },
        events
      )
    ).toBe(events);
  });

  test("does not add reminders to instruction output", () => {
    const result = { text: "instruction body" };

    expect(
      withCoordinationPrompt(
        {
          name: "instructions show",
          positionals: [],
          options: new Map<string, string | true>()
        },
        result
      )
    ).toBe(result);
  });
});

describe("prepareJsonResult", () => {
  const parsed = {
    name: "wait",
    positionals: [],
    options: new Map<string, string | true>()
  };
  const substantiveHandoff = {
    status: "Exact status with hostile-looking $(echo body) and unicode café.",
    next_action: "Preserve this entire next action verbatim.",
    open_questions: ["Does every byte survive?"],
    do_not: ["truncate anything"]
  };
  const result = {
    status: "your_turn",
    room_id: "room-1",
    turn_id: 7,
    lease_id: "lease-1",
    handoff: substantiveHandoff,
    next: "Restart one listener.",
    coordination_prompt: COORDINATION_PROMPT,
    events: [
      {
        event_seq: 41,
        event_id: "event-41",
        room_id: "room-1",
        turn_id: 7,
        event_type: "pass",
        handoff: substantiveHandoff,
        payload: null
      },
      {
        event_seq: 42,
        event_id: "event-42",
        room_id: "room-1",
        turn_id: 7,
        event_type: "message_sent",
        handoff: null,
        payload: {
          body: "Full message body\nwith a second line and $(hostile-looking text).",
          delivery_hint: "interrupt"
        }
      }
    ]
  };

  test("compacts only duplicated protocol fields and preserves substantive text", () => {
    const compact = prepareJsonResult(parsed, result) as Record<string, unknown>;
    expect(compact).not.toHaveProperty("coordination_prompt");
    expect(compact).not.toHaveProperty("next");
    expect(compact.handoff).toEqual(substantiveHandoff);

    const events = compact.events as Array<Record<string, unknown>>;
    expect(events[0]).not.toHaveProperty("room_id");
    expect(events[0]).not.toHaveProperty("turn_id");
    expect(events[0]).not.toHaveProperty("handoff");
    expect(events[1]).toMatchObject({
      event_id: "event-42",
      handoff: null,
      payload: result.events[1].payload
    });
  });

  test("verbose JSON preserves the full diagnostic representation", () => {
    const verbose = prepareJsonResult(
      {
        ...parsed,
        options: new Map<string, string | true>([["verbose", true]])
      },
      result
    );
    expect(verbose).toEqual(result);
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

  test("runs safely for harness-aware CLI invocations", () => {
    expect(
      shouldAutoSyncInstalledSkills(parsed, {
        TT_HARNESS_AGENT_ID: "codex:harness"
      })
    ).toBe(true);
    expect(
      shouldAutoSyncInstalledSkills(parsed, {
        CLAUDECODE: "1"
      })
    ).toBe(true);
    expect(
      shouldAutoSyncInstalledSkills(parsed, {
        CMUX_AGENT_LAUNCH_KIND: "grok"
      })
    ).toBe(true);
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
        name: "uninstall"
      }, {})
    ).toBe(false);
  });

  test("does not invoke skiller during startup skill sync", async () => {
    delete process.env.TALKING_STICK_DISABLE_SKILLER;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-startup-skiller-"));
    const logPath = path.join(root, "skiller.log");
    const fakeSkiller = path.join(root, "skiller");
    fs.writeFileSync(
      fakeSkiller,
      `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logPath)}, process.argv.slice(2).join(" ") + "\\n");
if (process.argv[2] === "version") {
  console.log(JSON.stringify({ schema: "skiller-version.v1", version: "v0.1.0" }));
} else {
  console.log(JSON.stringify({ schema: "skiller-plan.v1", actions: [] }));
}
`,
      "utf8"
    );
    fs.chmodSync(fakeSkiller, 0o755);

    await runStartupMaintenance(
      parsed,
      "file:///Users/alice/dev/ai/talking-stick/src/cli.ts",
      {
        HOME: root,
        PATH: process.env.PATH ?? "",
        SKILLER_BIN: fakeSkiller,
        TALKING_STICK_USE_SKILLER: "1"
      }
    );

    expect(fs.existsSync(logPath)).toBe(false);
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

  test("tt wait returns a live guardian pid", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    let guardianPid: number | undefined;

    try {
      await captureStdout(["join", project, "--agent", "human:worker"]);
      const waitOut = await captureStdout([
        "wait",
        project,
        "--timeout",
        "0ms",
        "--agent",
        "human:worker",
        "--json"
      ]);
      const waitResult = JSON.parse(waitOut) as {
        status: string;
        guardian_pid?: number;
        coordination_prompt?: string;
      };
      guardianPid = waitResult.guardian_pid;

      expect(waitResult.status).toBe("your_turn");
      expect(guardianPid).toEqual(expect.any(Number));
      expect(isPidAlive(guardianPid as number)).toBe(true);
      expect(waitResult.coordination_prompt).toBeUndefined();
    } finally {
      await releaseIfHeld(project, "human:worker");
      killPidIfAlive(guardianPid);
    }
  });

  test("tt wait rejects audit targets so they cannot skip self events", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    await expect(
      captureStdout([
        "wait",
        project,
        "--target",
        "any",
        "--timeout",
        "0ms",
        "--agent",
        "human:worker",
        "--json"
      ])
    ).rejects.toThrow(/manages the self cursor only/);
  });

  test("tt wait accepts an explicit replay cursor and returns events with a live guardian", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    let guardianPid: number | undefined;

    try {
      await captureStdout(["join", project, "--agent", "human:worker"]);
      const waitOut = await captureStdout([
        "wait",
        project,
        "--events",
        "--after",
        "0",
        "--timeout",
        "0ms",
        "--agent",
        "human:worker",
        "--json"
      ]);
      const waitResult = JSON.parse(waitOut) as {
        status: string;
        guardian_pid?: number;
        events?: Array<{ event_seq: number; event_type: string }>;
        cursor_event_seq?: number;
        wake_reason?: string;
      };
      guardianPid = waitResult.guardian_pid;

      expect(waitResult.status).toBe("your_turn");
      expect(waitResult.wake_reason).toBe("turn");
      expect(waitResult.events?.map((event) => event.event_type)).toEqual([
        "claim"
      ]);
      expect(waitResult.cursor_event_seq).toBe(
        waitResult.events?.[0].event_seq
      );
      expect(guardianPid).toEqual(expect.any(Number));
      expect(isPidAlive(guardianPid as number)).toBe(true);
      expect(
        readCliSessions(resolveCliSessionPath()).find(
          (session) => session.agent_id === "human:worker"
        )?.event_cursor_seq
      ).toBe(0);
    } finally {
      await releaseIfHeld(project, "human:worker");
      killPidIfAlive(guardianPid);
    }
  });

  test("tt wait includes events and manages its cursor without flags", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    let guardianPid: number | undefined;
    try {
      await captureStdout(["join", project, "--agent", "human:worker"]);
      const first = JSON.parse(await captureStdout([
        "wait", project, "--timeout", "0ms", "--agent", "human:worker", "--json"
      ])) as {
        cursor_event_seq: number;
        events: Array<{ event_type: string }>;
        guardian_pid: number;
      };
      guardianPid = first.guardian_pid;
      expect(first.events.map((event) => event.event_type)).toContain("claim");

      const second = JSON.parse(await captureStdout([
        "try", project, "--agent", "human:worker", "--json"
      ])) as { cursor_event_seq: number; events: unknown[] };
      expect(second.events).toEqual([]);
      expect(second.cursor_event_seq).toBe(first.cursor_event_seq);

      await captureStdout([
        "try", project, "--after", "0", "--agent", "human:worker", "--json"
      ]);
      await captureStdout([
        "try", project, "--after", "999999", "--agent", "human:worker", "--json"
      ]);

      const session = readCliSessions(resolveCliSessionPath()).find(
        (candidate) => candidate.agent_id === "human:worker"
      );
      expect(session?.event_cursor_seq).toBe(first.cursor_event_seq);
    } finally {
      await releaseIfHeld(project, "human:worker");
      killPidIfAlive(guardianPid);
    }
  });

  test("one long-running wait process stays open and exits on an OOB message", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    let guardianPid: number | undefined;
    try {
      const first = JSON.parse(await captureStdout([
        "wait", project, "--timeout", "0ms", "--agent", "human:a", "--json"
      ])) as { guardian_pid: number };
      guardianPid = first.guardian_pid;

      const listener = spawnCliProcess([
        "wait", project, "--timeout", "5s", "--agent", "human:a", "--json"
      ]);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(listener.child.exitCode).toBeNull();

      await captureStdout(["join", project, "--agent", "human:b", "--json"]);
      await captureStdout([
        "msg", "send", "human:a", "hello", "--path", project,
        "--agent", "human:b", "--json"
      ]);

      const close = await waitForProcessClose(listener.child, 5_000);
      expect(close.code).toBe(0);
      const result = JSON.parse(listener.stdout()) as {
        events: Array<{ event_type: string; payload?: { body?: string } }>;
      };
      expect(result.events).toContainEqual(
        expect.objectContaining({
          event_type: "message_sent",
          payload: expect.objectContaining({ body: "hello" })
        })
      );
    } finally {
      await releaseIfHeld(project, "human:a");
      killPidIfAlive(guardianPid);
      try {
        await captureStdout(["leave", project, "--agent", "human:b", "--json"]);
      } catch {
        // best-effort fixture cleanup
      }
    }
  });

  test("health reports the registered wait and a duplicate wait is rejected", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    let guardianPid: number | undefined;
    let listener: SpawnedCliProcess | undefined;
    try {
      const first = JSON.parse(await captureStdout([
        "wait", project, "--timeout", "0ms", "--agent", "human:receiver", "--json"
      ])) as { guardian_pid: number };
      guardianPid = first.guardian_pid;

      listener = spawnCliProcess([
        "wait", project, "--timeout", "5s", "--agent", "human:receiver", "--json"
      ]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(listener.child.exitCode).toBeNull();

      const health = JSON.parse(await captureStdout([
        "health", project, "--agent", "human:receiver", "--json"
      ])) as {
        listener: { status: string; active: boolean; duplicates: number };
      };
      expect(health.listener).toEqual({
        status: "registered",
        active: true,
        duplicates: 0
      });

      const duplicate = spawnCliProcess([
        "wait", project, "--timeout", "5s", "--agent", "human:receiver", "--json"
      ]);
      const duplicateClose = await waitForProcessClose(duplicate.child, 3_000);
      expect(duplicateClose.code).toBe(1);
      expect(duplicate.stderr()).toContain("duplicate_listener");

      await captureStdout(["join", project, "--agent", "human:sender", "--json"]);
      await captureStdout([
        "msg", "send", "human:receiver", "wake", "--path", project,
        "--agent", "human:sender", "--json"
      ]);
      expect((await waitForProcessClose(listener.child, 5_000)).code).toBe(0);
    } finally {
      listener?.child.kill("SIGKILL");
      await releaseIfHeld(project, "human:receiver");
      killPidIfAlive(guardianPid);
    }
  });

  test("tt wait repairs a missing guardian for an existing owner", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    let firstGuardianPid: number | undefined;
    let repairedGuardianPid: number | undefined;

    try {
      await captureStdout(["join", project, "--agent", "human:worker"]);
      const firstWaitOut = await captureStdout([
        "wait",
        project,
        "--timeout",
        "0ms",
        "--agent",
        "human:worker",
        "--json"
      ]);
      const firstWait = JSON.parse(firstWaitOut) as {
        status: string;
        guardian_pid: number;
      };
      firstGuardianPid = firstWait.guardian_pid;
      expect(firstWait.status).toBe("your_turn");
      expect(isPidAlive(firstGuardianPid)).toBe(true);

      process.kill(firstGuardianPid, "SIGTERM");
      await waitForPidGone(firstGuardianPid);

      const secondWaitOut = await captureStdout([
        "wait",
        project,
        "--timeout",
        "0ms",
        "--agent",
        "human:worker",
        "--json"
      ]);
      const secondWait = JSON.parse(secondWaitOut) as {
        status: string;
        reason: string;
        guardian_pid: number;
      };
      repairedGuardianPid = secondWait.guardian_pid;

      expect(secondWait.status).toBe("your_turn");
      expect(secondWait.reason).toBe("already_owner");
      expect(repairedGuardianPid).toEqual(expect.any(Number));
      expect(isPidAlive(repairedGuardianPid)).toBe(true);
    } finally {
      await releaseIfHeld(project, "human:worker");
      killPidIfAlive(firstGuardianPid);
      killPidIfAlive(repairedGuardianPid);
    }
  });

  test("tt wait spawns a guardian for an already-owner with no recorded guardian", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    let firstGuardianPid: number | undefined;
    let repairedGuardianPid: number | undefined;

    try {
      await captureStdout(["join", project, "--agent", "human:worker"]);
      const firstWaitOut = await captureStdout([
        "wait",
        project,
        "--timeout",
        "0ms",
        "--agent",
        "human:worker",
        "--json"
      ]);
      const firstWait = JSON.parse(firstWaitOut) as {
        status: string;
        guardian_pid: number;
      };
      firstGuardianPid = firstWait.guardian_pid;
      expect(firstWait.status).toBe("your_turn");
      expect(isPidAlive(firstGuardianPid)).toBe(true);

      process.kill(firstGuardianPid, "SIGTERM");
      await waitForPidGone(firstGuardianPid);
      fs.rmSync(resolveCliSessionPath(), { force: true });

      const secondWaitOut = await captureStdout([
        "wait",
        project,
        "--timeout",
        "0ms",
        "--agent",
        "human:worker",
        "--json"
      ]);
      const secondWait = JSON.parse(secondWaitOut) as {
        status: string;
        reason: string;
        guardian_pid: number;
      };
      repairedGuardianPid = secondWait.guardian_pid;

      expect(secondWait.status).toBe("your_turn");
      expect(secondWait.reason).toBe("already_owner");
      expect(repairedGuardianPid).toEqual(expect.any(Number));
      expect(isPidAlive(repairedGuardianPid)).toBe(true);
    } finally {
      await releaseIfHeld(project, "human:worker");
      killPidIfAlive(firstGuardianPid);
      killPidIfAlive(repairedGuardianPid);
    }
  });

  test("tt wait --park does not auto-claim an idle room", async () => {
    const { project } = setupIsolatedCli(tempDirs);

    await captureStdout(["join", project, "--agent", "human:worker"]);
    const waitOut = await captureStdout([
      "wait",
      project,
      "--park",
      "--timeout",
      "0ms",
      "--agent",
      "human:worker",
      "--json"
    ]);
    const waitResult = JSON.parse(waitOut) as {
      status: string;
      reason?: string;
      hint?: string;
      guardian_pid?: number;
    };

    expect(waitResult.status).toBe("not_yet");
    expect(waitResult.reason).toBeUndefined();
    expect(waitResult.hint).toBeUndefined();
    expect(waitResult.guardian_pid).toBeUndefined();

    const service = new TalkingStickService();
    try {
      const rooms = service.listRooms({ context_path: project });
      const room = rooms.rooms[0];
      const events = service.getRoomEvents({ room_id: room.room_id });
      expect(events.some((event) => event.event_type === "claim")).toBe(false);
    } finally {
      service.close();
    }
  });

  test("tt wait --park returns your_turn with a guardian for the reserved recipient", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    let guardianPid: number | undefined;

    await seedCliLease(project, "human:owner", ["human:next"]);
    try {
      await captureStdout([
        "pass",
        project,
        "human:next",
        "--agent",
        "human:owner",
        "--status",
        "Owner is passing.",
        "--next-action",
        "Take the reserved turn.",
        "--json"
      ]);

      const waitOut = await captureStdout([
        "wait",
        project,
        "--park",
        "--timeout",
        "0ms",
        "--agent",
        "human:next",
        "--json"
      ]);
      const waitResult = JSON.parse(waitOut) as {
        status: string;
        reason: string;
        guardian_pid?: number;
      };
      guardianPid = waitResult.guardian_pid;

      expect(waitResult.status).toBe("your_turn");
      expect(waitResult.reason).toBe("sequence");
      expect(guardianPid).toEqual(expect.any(Number));
      expect(isPidAlive(guardianPid as number)).toBe(true);
    } finally {
      await releaseIfHeld(project, "human:next");
      killPidIfAlive(guardianPid);
    }
  });

  test("tt standby --wake manual returns immediately and exposes parked diagnostics", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    await captureStdout(["join", project, "--agent", "human:parked"]);

    const output = JSON.parse(await captureStdout([
      "standby",
      project,
      "--wake",
      "manual",
      "--agent",
      "human:parked",
      "--json"
    ])) as {
      status: string;
      wait_intent: string;
      transport: string;
      can_self_wake: boolean;
    };

    expect(output).toMatchObject({
      status: "standby_registered",
      wait_intent: "parked",
      transport: "manual",
      can_self_wake: false
    });
    const state = JSON.parse(await captureStdout([
      "state", project, "--agent", "human:parked", "--json"
    ])) as { members: Array<{ agent_id: string; wait_intent: string }> };
    expect(state.members.find((member) => member.agent_id === "human:parked"))
      .toMatchObject({ wait_intent: "parked" });
  });

  test("tt standby rejects an active owner until the turn is released", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    await seedCliLease(project, "human:owner");

    await expect(captureStdout([
      "standby",
      project,
      "--wake",
      "manual",
      "--agent",
      "human:owner",
      "--json"
    ])).rejects.toMatchObject({ code: "park_requires_release" });
  });

  test("tt assign next resolves the fair active recipient", async () => {
    const { project } = setupIsolatedCli(tempDirs);

    await seedCliLease(project, "human:owner", ["human:next"]);
    const service = new TalkingStickService();
    try {
      const roomId = readCliSessions(resolveCliSessionPath()).find(
        (session) => session.agent_id === "human:owner"
      )!.room_id;
      const state = service.getRoomState({ room_id: roomId });
      service.registerReceiver({
        agent_id: "human:next",
        room_id: state.room.room_id,
        receiver_id: "next-receiver",
        host_id: os.hostname(),
        pid: process.pid,
        process_started_at: getCurrentProcessStartedAt(),
        cursor_event_seq: state.cursor_event_seq
      });
    } finally {
      service.close();
    }

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

  test("operator-requested assign can name an unreachable alias", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    await seedCliLease(project, "human:owner", [
      "human:sleeper",
      "human:live"
    ]);

    const service = new TalkingStickService();
    try {
      const roomId = readCliSessions(resolveCliSessionPath()).find(
        (session) => session.agent_id === "human:owner"
      )!.room_id;
      const state = service.getRoomState({
        room_id: roomId
      });
      service.registerReceiver({
        agent_id: "human:live",
        room_id: state.room.room_id,
        receiver_id: "live-receiver",
        host_id: os.hostname(),
        pid: process.pid,
        process_started_at: getCurrentProcessStartedAt(),
        cursor_event_seq: state.cursor_event_seq
      });
    } finally {
      service.close();
    }

    await expect(captureStdout([
      "assign", "sleeper", project,
      "--agent", "human:owner",
      "--status", "Assigning explicitly.",
      "--next-action", "Take the assigned turn.",
      "--json"
    ])).rejects.toThrow(/No reachable room member/);

    const assigned = JSON.parse(await captureStdout([
      "assign", "sleeper", project,
      "--agent", "human:owner",
      "--status", "Operator override.",
      "--next-action", "Resume when available.",
      "--operator-requested",
      "--json"
    ])) as { reserved_for: string };
    expect(assigned.reserved_for).toBe("human:sleeper");
  });

  test("ordinary alias assign rejects an unreachable target in a receiverless room", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    await seedCliLease(project, "human:owner", ["human:sleeper"]);

    await expect(captureStdout([
      "assign", "sleeper", project,
      "--agent", "human:owner",
      "--status", "Assigning normally.",
      "--next-action", "Take the assigned turn.",
      "--json"
    ])).rejects.toThrow(/No reachable room member/);
  });

  test.each(["release", "pass", "assign"])(
    "tt %s rejects --path instead of silently using cwd",
    async (command) => {
      const args = command === "assign"
        ? [command, "human:reviewer", "--path", "/tmp/wrong-room"]
        : [command, "--path", "/tmp/wrong-room"];
      await expect(captureStdout([...args, "--json"]))
        .rejects.toThrow(/takes its workspace path positionally/);
    }
  );

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

  test("tt join and tt state JSON expose cursor_event_seq", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    let guardianPid: number | undefined;

    try {
      const joinOut = await captureStdout([
        "join",
        project,
        "--agent",
        "human:cursor-test",
        "--json"
      ]);
      const joined = JSON.parse(joinOut) as { cursor_event_seq: number };
      expect(joined.cursor_event_seq).toBe(0);

      const waitOut = await captureStdout([
        "wait",
        project,
        "--timeout",
        "0ms",
        "--agent",
        "human:cursor-test",
        "--json"
      ]);
      const waitResult = JSON.parse(waitOut) as { guardian_pid: number };
      guardianPid = waitResult.guardian_pid;

      const stateOut = await captureStdout([
        "state",
        project,
        "--agent",
        "human:cursor-test",
        "--json"
      ]);
      const state = JSON.parse(stateOut) as { cursor_event_seq: number };
      expect(state.cursor_event_seq).toBe(1);
    } finally {
      await releaseIfHeld(project, "human:cursor-test");
      killPidIfAlive(guardianPid);
    }
  });

  test("tt health is non-authoritative and tt status aliases it", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    await captureStdout(["join", project, "--agent", "human:health-test"]);

    const before = snapshotCliState();
    const healthOut = await captureStdout([
      "health",
      project,
      "--agent",
      "human:health-test",
      "--json"
    ]);
    const health = JSON.parse(healthOut) as {
      room: { canonical_path: string };
      owner: string | null;
      you_own: boolean;
      guardian: { status: string };
      listener: { active: boolean; duplicates: number };
      git: { dirty: boolean; summary: string };
      next_action: string;
      coordination_prompt?: string;
    };

    const afterHealth = snapshotCliState() as {
      rooms: unknown;
      events: unknown;
      notes: unknown;
      sessions: unknown;
    };
    const beforeState = before as {
      rooms: unknown;
      events: unknown;
      notes: unknown;
      sessions: unknown;
    };
    expect(afterHealth.rooms).toEqual(beforeState.rooms);
    expect(afterHealth.events).toEqual(beforeState.events);
    expect(afterHealth.notes).toEqual(beforeState.notes);
    expect(afterHealth.sessions).toEqual(beforeState.sessions);
    expect(health.room.canonical_path).toBe(project);
    expect(health.owner).toBeNull();
    expect(health.you_own).toBe(false);
    expect(health.guardian.status).toBe("not_recorded");
    expect(health.listener.active).toBe(false);
    expect(health.listener.duplicates).toBe(0);
    expect(health.git.dirty).toBe(false);
    expect(health.next_action).toContain("tt wait");
    expect(health.coordination_prompt).toBeUndefined();

    const statusOut = await captureStdout([
      "status",
      project,
      "--agent",
      "human:health-test",
      "--json"
    ]);
    const status = JSON.parse(statusOut) as {
      room: { canonical_path: string };
      coordination_prompt?: string;
    };
    const afterStatus = snapshotCliState() as {
      rooms: unknown;
      events: unknown;
      notes: unknown;
      sessions: unknown;
    };
    expect(afterStatus.rooms).toEqual(beforeState.rooms);
    expect(afterStatus.events).toEqual(beforeState.events);
    expect(afterStatus.notes).toEqual(beforeState.notes);
    expect(afterStatus.sessions).toEqual(beforeState.sessions);
    expect(status.room.canonical_path).toBe(project);
    expect(status.coordination_prompt).toBeUndefined();
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

  test("stateful command help is side-effect-free", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    await seedCliLease(project, "human:owner", ["human:next"]);
    await captureStdout([
      "release",
      project,
      "--agent",
      "human:owner",
      "--status",
      "Owner left a pending handoff.",
      "--next-action",
      "Next agent should claim.",
      "--json"
    ]);

    const helpCases: Array<{ argv: string[]; usage: string }> = [
      { argv: ["wait", project, "--help"], usage: "Usage: tt wait" },
      { argv: ["wait", project, "-h"], usage: "Usage: tt wait" },
      { argv: ["--json", "wait", project, "--help"], usage: "Usage: tt wait" },
      {
        argv: ["--agent", "human:helper", "wait", project, "--help"],
        usage: "Usage: tt wait"
      },
      { argv: ["help", "wait"], usage: "Usage: tt wait" },
      { argv: ["try", project, "--help"], usage: "Usage: tt try" },
      { argv: ["take", project, "--help"], usage: "Usage: tt take" },
      { argv: ["takeover", project, "--help"], usage: "Usage: tt take" },
      { argv: ["release", project, "--help"], usage: "Usage: tt release" },
      { argv: ["pass", project, "--help"], usage: "Usage: tt pass" },
      {
        argv: ["assign", "human:next", project, "--help"],
        usage: "Usage: tt assign"
      },
      { argv: ["join", project, "--help"], usage: "Usage: tt join" },
      { argv: ["leave", project, "--help"], usage: "Usage: tt leave" },
      { argv: ["health", project, "--help"], usage: "Usage: tt health" },
      { argv: ["status", project, "--help"], usage: "Usage: tt health" },
      {
        argv: ["kick", "human:next", project, "--help"],
        usage: "Usage: tt kick"
      },
      {
        argv: ["notes", "add", "note body", "--path", project, "--help"],
        usage: "Usage: tt notes"
      },
      {
        argv: ["msg", "send", "room", "body", "--path", project, "--help"],
        usage: "Usage: tt msg"
      }
    ];

    for (const item of helpCases) {
      const before = snapshotCliState();
      const out = await captureStdout(item.argv);

      expect(out).toContain(item.usage);
      expect(out).toContain("--help, -h");
      expect(snapshotCliState()).toEqual(before);
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

  test("tt instructions show returns the selected bundled harness prompt", async () => {
    const out = await captureStdout([
      "instructions",
      "show",
      "--harness",
      "codex",
      "--scope",
      "bundled",
      "--json"
    ]);
    const result = JSON.parse(out) as {
      harness: string;
      scope: string;
      text: string;
    };

    expect(result.harness).toBe("codex");
    expect(result.scope).toBe("bundled");
    expect(result.text).toContain("tt wait --json");
  });

  test("tt instructions show returns the bundled Grok prompt", async () => {
    const out = await captureStdout([
      "instructions",
      "show",
      "--harness",
      "grok",
      "--scope",
      "bundled",
      "--json"
    ]);
    const result = JSON.parse(out) as {
      harness: string;
      text: string;
    };

    expect(result.harness).toBe("grok");
    expect(result.text).toContain("tt wait --json");
  });

  test("tt instructions show preserves a path after trailing --json", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    const out = await captureStdout([
      "instructions",
      "show",
      "--harness",
      "codex",
      "--scope",
      "bundled",
      "--json",
      project
    ]);
    const result = JSON.parse(out) as {
      paths: { project: string };
    };

    expect(result.paths.project).toBe(
      path.join(project, ".talking-stick", "instructions.md")
    );
  });

  test("tt install --print includes skill actions", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-install-home-"));
    tempDirs.push(home);
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    let out = "";
    try {
      out = await captureStdout(["install", "codex", "--print"]);
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }

    expect(out).toContain("[codex] link ");
    expect(out).toContain(".agents/skills/talking-stick");
    expect(out).toContain("[codex] remove duplicate skill symlink ");
    expect(out).toContain(".codex/skills/talking-stick");
  });

  test("tt install --copy --print plans a copied skill", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-install-home-"));
    tempDirs.push(home);
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    let out = "";
    try {
      out = await captureStdout([
        "install",
        "codex",
        "--print",
        "--copy"
      ]);
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }

    expect(out).toContain("[codex] copy ");
    expect(out).toContain(".agents/skills/talking-stick");
  });

  test("tt install grok --print includes native skill and session hook actions", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-install-grok-home-"));
    tempDirs.push(home);
    const grokHome = path.join(home, ".grok");
    fs.mkdirSync(grokHome, { recursive: true });
    process.env.GROK_HOME = grokHome;

    const out = await captureStdout(["install", "grok", "--print"]);

    expect(out).toContain("[grok] link ");
    expect(out).toContain(".agents/skills/talking-stick");
    expect(out).toContain("[grok] remove duplicate skill symlink ");
    expect(out).toContain(".grok/skills/talking-stick");
    expect(out).toContain("[grok] write Grok session hook ");
    expect(out).toContain(".grok/hooks/talking-stick-session.json");
  });

  test("tt install gemini --print is cleanup-only and points to Antigravity", async () => {
    const out = await captureStdout(["install", "gemini", "--print"]);

    expect(out).toContain("Gemini CLI skill install is deprecated");
    expect(out).toContain("tt install antigravity");
    expect(out).not.toContain("gemini skills link");
    expect(out).not.toContain("gemini skills install");
    expect(out).toContain(".gemini/skills/talking-stick");
  });

  test("tt install rejects conflicting skill link modes", async () => {
    await expect(
      captureStdout(["install", "codex", "--print", "--copy", "--link"])
    ).rejects.toThrow(/Pass only one of --copy or --link/);
  });

  test("tt install --replace exposes an explicit replacement plan", async () => {
    const out = await captureStdout([
      "install",
      "codex",
      "--replace",
      "--print"
    ]);
    expect(out).toContain("talking-stick");
    expect(out).toContain("link");
  });

  test("tt uninstall --print includes skill removal", async () => {
    const out = await captureStdout(["uninstall", "codex", "--print"]);

    expect(out).toContain("[codex] remove ");
    expect(out).toContain(".codex/skills/talking-stick");
    expect(out).toContain("Left ~/.agents/skills/talking-stick");
  });

  test("tt uninstall agents --print removes the shared skill target", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-uninstall-home-"));
    tempDirs.push(home);
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    let out = "";
    try {
      out = await captureStdout(["uninstall", "agents", "--print"]);
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }

    expect(out).toContain("remove shared agents skill");
    expect(out).toContain(".agents/skills/talking-stick");
    expect(out).not.toContain("Left ~/.agents/skills/talking-stick");
  });

  test("tt uninstall --shared --print removes the shared skill target", async () => {
    const out = await captureStdout(["uninstall", "--shared", "--print"]);

    expect(out).toContain("remove shared agents skill");
    expect(out).toContain(".agents/skills/talking-stick");
  });

  test("tt uninstall antigravity --print leaves the shared skill", async () => {
    const out = await captureStdout(["uninstall", "antigravity", "--print"]);

    expect(out).not.toContain("remove shared agents skill");
    expect(out).toContain("Left ~/.agents/skills/talking-stick");
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

  test("tt msg send --stdin reads the message body from stdin", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    const roomId = seedCliRoomMembers(project, [
      { agent_id: "human:sender", display_name: "sender" },
      { agent_id: "codex:target", display_name: "codex" }
    ]);

    const sendOut = await runCliProcess(
      [
        "msg",
        "send",
        "codex",
        "--stdin",
        "--agent",
        "human:sender",
        "--path",
        project,
        "--json"
      ],
      "body from stdin"
    );
    const sent = JSON.parse(sendOut.stdout) as { event_seq: number };
    expect(sent.event_seq).toBeGreaterThan(0);

    const service = new TalkingStickService();
    try {
      const events = service.getRoomEvents({ room_id: roomId });
      expect(events[0]).toMatchObject({
        to_agent_id: "codex:target",
        payload: {
          body: "body from stdin",
          delivery_hint: "normal"
        }
      });
    } finally {
      service.close();
    }
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

  test("tt msg recv --wait --after resumes from an explicit cursor", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    const roomId = seedCliRoomMembers(project, [
      { agent_id: "human:sender", display_name: "sender" },
      { agent_id: "human:receiver", display_name: "receiver" }
    ]);
    sendCliTestMessage(roomId, "human:sender", "human:receiver", "first");
    sendCliTestMessage(roomId, "human:sender", "human:receiver", "second");

    const service = new TalkingStickService();
    let firstSeq: number;
    try {
      const events = service.getRoomEvents({ room_id: roomId });
      firstSeq = events[0].event_seq;
    } finally {
      service.close();
    }

    const recvOut = await captureStdout([
      "msg",
      "recv",
      "--wait",
      "--after",
      String(firstSeq),
      "--timeout",
      "20ms",
      "--agent",
      "human:receiver",
      "--path",
      project,
      "--json"
    ]);
    const events = parseJsonLines(recvOut);

    expect(events).toHaveLength(1);
    expect(events[0].payload.body).toBe("second");
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

  test("tt msg recv --follow emits JSON lines and exits cleanly on SIGTERM", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    const roomId = seedCliRoomMembers(project, [
      { agent_id: "human:sender", display_name: "sender" },
      { agent_id: "human:receiver", display_name: "receiver" }
    ]);
    const watcher = spawnCliProcess([
      "msg",
      "recv",
      "--follow",
      "--after",
      "0",
      "--timeout",
      "50ms",
      "--agent",
      "human:receiver",
      "--path",
      project,
      "--json"
    ]);

    sendCliTestMessage(roomId, "human:sender", "human:receiver", "follow me");
    const line = await waitForFirstStdoutLine(watcher);
    const event = JSON.parse(line);

    const closePromise = waitForProcessClose(watcher.child);
    watcher.child.kill("SIGTERM");
    const close = await closePromise;

    expect(close).toMatchObject({ code: 0, signal: null });
    expect(event).toMatchObject({
      from_agent_id: "human:sender",
      to_agent_id: "human:receiver",
      payload: { body: "follow me" }
    });
    expect(watcher.stderr()).toContain(
      `cursor_event_seq=${event.event_seq}`
    );
  });

  test("tt msg recv stays messages-only when a turn is passed", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    const roomId = seedCliRoomMembers(project, [
      { agent_id: "human:owner", display_name: "owner" },
      { agent_id: "human:receiver", display_name: "receiver" }
    ]);

    const recvPromise = captureStdout([
      "msg",
      "recv",
      "--wait",
      "--timeout",
      "100ms",
      "--agent",
      "human:receiver",
      "--path",
      project,
      "--json"
    ]);
    const passPromise = delay(25).then(() =>
      passCliTestTurn(roomId, "human:owner", "human:receiver")
    );

    expect(await recvPromise).toBe("");
    await passPromise;
  });

  test("tt events --wait defaults to self and emits JSON lines", async () => {
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

  test("tt events --wait default self ignores unrelated direct messages", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    const roomId = seedCliRoomMembers(project, [
      { agent_id: "human:sender", display_name: "sender" },
      { agent_id: "human:receiver", display_name: "receiver" },
      { agent_id: "human:observer", display_name: "observer" }
    ]);

    const eventsPromise = captureStdout([
      "events",
      project,
      "--wait",
      "--event",
      "message_sent",
      "--timeout",
      "2s",
      "--agent",
      "human:observer",
      "--json"
    ]);
    setTimeout(() => {
      sendCliTestMessage(
        roomId,
        "human:sender",
        "human:receiver",
        "not for observer"
      );
      sendCliTestMessage(
        roomId,
        "human:sender",
        "human:observer",
        "for observer"
      );
    }, 25);

    const events = parseJsonLines(await eventsPromise);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: "message_sent",
      to_agent_id: "human:observer",
      payload: { body: "for observer" }
    });
  });

  test("tt events --follow --target any sees messages for other agents", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    const roomId = seedCliRoomMembers(project, [
      { agent_id: "human:sender", display_name: "sender" },
      { agent_id: "human:receiver", display_name: "receiver" },
      { agent_id: "human:observer", display_name: "observer" }
    ]);
    const watcher = spawnCliProcess([
      "events",
      project,
      "--follow",
      "--after",
      "0",
      "--target",
      "any",
      "--timeout",
      "50ms",
      "--agent",
      "human:observer",
      "--json"
    ]);

    sendCliTestMessage(roomId, "human:sender", "human:receiver", "not for observer");
    const line = await waitForFirstStdoutLine(watcher);
    const event = JSON.parse(line);

    const closePromise = waitForProcessClose(watcher.child);
    watcher.child.kill("SIGTERM");
    const close = await closePromise;

    expect(close).toMatchObject({ code: 0, signal: null });
    expect(event).toMatchObject({
      event_type: "message_sent",
      from_agent_id: "human:sender",
      to_agent_id: "human:receiver",
      payload: { body: "not for observer" }
    });
  });

  test("tt events --follow defaults to self and sees direct messages and turn handoffs", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    const roomId = seedCliRoomMembers(project, [
      { agent_id: "human:owner", display_name: "owner" },
      { agent_id: "human:receiver", display_name: "receiver" }
    ]);
    const watcher = spawnCliProcess([
      "events",
      project,
      "--follow",
      "--after",
      "0",
      "--timeout",
      "50ms",
      "--agent",
      "human:receiver",
      "--json"
    ]);

    sendCliTestMessage(roomId, "human:owner", "human:receiver", "direct");
    await passCliTestTurn(roomId, "human:owner", "human:receiver");
    const lines = await waitForStdoutLines(watcher, 2);
    const events = lines.map((line) => JSON.parse(line));

    const closePromise = waitForProcessClose(watcher.child);
    watcher.child.kill("SIGTERM");
    const close = await closePromise;

    expect(close).toMatchObject({ code: 0, signal: null });
    expect(events.map((event) => event.event_type)).toEqual([
      "message_sent",
      "pass"
    ]);
    expect(events[0]).toMatchObject({
      from_agent_id: "human:owner",
      to_agent_id: "human:receiver",
      payload: { body: "direct" }
    });
    expect(events[1]).toMatchObject({
      from_agent_id: "human:owner",
      to_agent_id: "human:receiver",
      handoff: {
        status: "Owner is passing.",
        next_action: "Receiver should claim."
      }
    });
  });

  test("tt events --target self uses harness identity without TT_HARNESS_AGENT_ID", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    const harnessEnv = {
      CODEX_THREAD_ID: "stage2-thread"
    };
    const joinOut = await runCliProcess([
      "join",
      project,
      "--json"
    ], "", harnessEnv);
    const joined = JSON.parse(joinOut.stdout) as {
      agent_id: string;
      room_id: string;
    };

    const service = new TalkingStickService();
    try {
      const sender = deriveHumanCliIdentity({
        agentId: "human:sender",
        displayName: "sender"
      });
      const owner = deriveHumanCliIdentity({
        agentId: "human:owner",
        displayName: "owner"
      });
      service.joinPath({
        agent_id: sender.agent_id,
        context_path: project,
        process_metadata: sender.process_metadata
      });
      service.joinPath({
        agent_id: owner.agent_id,
        context_path: project,
        process_metadata: owner.process_metadata
      });
      service.sendMessage({
        agent_id: sender.agent_id,
        room_id: joined.room_id,
        to_agent_id: joined.agent_id,
        body: "direct to harness"
      });

      const turn = await service.waitForTurn({
        agent_id: owner.agent_id,
        room_id: joined.room_id,
        max_wait_ms: 0
      });
      expect(turn.status).toBe("your_turn");
      if (turn.status !== "your_turn") {
        throw new Error(`Expected owner turn, got ${turn.status}`);
      }
      service.passStick({
        agent_id: owner.agent_id,
        room_id: joined.room_id,
        lease_id: turn.lease_id,
        expected_turn_id: turn.turn_id,
        to_agent_id: joined.agent_id,
        handoff: {
          status: "Owner is passing.",
          next_action: "Harness should claim."
        },
        operator_override: true
      });
    } finally {
      service.close();
    }

    const eventsOut = await runCliProcess([
      "events",
      project,
      "--wait",
      "--after",
      "0",
      "--target",
      "self",
      "--timeout",
      "100ms",
      "--json"
    ], "", harnessEnv);
    const events = parseJsonLines(eventsOut.stdout);

    expect(joined.agent_id).toMatch(/^codex:/);
    expect(events.map((event) => event.event_type)).toEqual([
      "message_sent",
      "pass"
    ]);
    expect(events[0]).toMatchObject({
      to_agent_id: joined.agent_id,
      payload: { body: "direct to harness" }
    });
    expect(events[1]).toMatchObject({
      to_agent_id: joined.agent_id,
      handoff: {
        status: "Owner is passing.",
        next_action: "Harness should claim."
      }
    });
  });
});

describe("harness heartbeat and health output hardening", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("harness heartbeat updates last_seen_at and metadata on runtime commands", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    process.env.TT_HARNESS_AGENT_ID = "codex:harness-test";

    // 1. Join room
    const joinOut = await captureStdout(["join", project, "--json"]);
    const joined = JSON.parse(joinOut);
    const roomId = joined.room_id;

    // Capture DB state
    const service = new TalkingStickService();
    let initialMember;
    try {
      initialMember = service.getRoomState({ room_id: roomId, agent_id: "codex:harness-test" }).members[0];
    } finally {
      service.close();
    }

    await delay(100);

    // 2. Run a command (e.g. state)
    await captureStdout(["state", project, "--json"]);

    // Assert last_seen_at is updated
    const service2 = new TalkingStickService();
    try {
      const updatedMember = service2.getRoomState({ room_id: roomId, agent_id: "codex:harness-test" }).members[0];
      expect(new Date(updatedMember.last_seen_at).getTime()).toBeGreaterThan(new Date(initialMember.last_seen_at).getTime());
    } finally {
      service2.close();
    }
  });

  test("concise health output by default and verbose with --verbose/--all", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    await captureStdout(["join", project, "--agent", "human:health-concise"]);

    const healthOut = await captureStdout([
      "health",
      project,
      "--agent",
      "human:health-concise"
    ]);

    expect(healthOut).toContain("Room:");
    expect(healthOut).toContain("Owner:");
    expect(healthOut).toContain("Guardian:");
    expect(healthOut).toContain("Listener:");
    expect(healthOut).toContain("Git:");
    expect(healthOut).toContain("Next:");
    expect(healthOut).not.toContain("Local:");
    expect(healthOut).not.toContain("Workspace:");
    expect(healthOut).not.toContain("Members:");

    const healthVerboseOut = await captureStdout([
      "health",
      project,
      "--agent",
      "human:health-concise",
      "--verbose"
    ]);

    expect(healthVerboseOut).toContain("Local:");
    expect(healthVerboseOut).toContain("Workspace:");
    expect(healthVerboseOut).toContain("Members:");
  });

  test("wait output describes enforced duplicate rejection", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    await captureStdout(["join", project, "--agent", "human:wait-reminder", "--json"]);
    const waitOut = await captureStdout([
      "try",
      project,
      "--agent",
      "human:wait-reminder"
    ]);
    expect(waitOut).toContain(
      "next: Keep one `tt wait --json` running; a duplicate for this room member is rejected."
    );
  });

  test("receiver scan scopes to caller root and dedupes wrapper processes", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    const { scanReceiverProcesses } = await import("../src/cli/room-commands.js");
    const room = {
      room_id: "room-1",
      canonical_path: project,
      sequence_index: 0,
      owner: null,
      reserved_for: null,
      pending_handoff_event_seq: null,
      turn_id: 0,
      lease_id: null,
      lease_expires_at: null,
      claim_expires_at: null,
      state: "idle",
      updated_at: new Date().toISOString()
    } as const;

    const result = scanReceiverProcesses(room, {
      root_pid: 100,
      read_cwd: () => project,
      process_rows: [
        { pid: 100, ppid: 1, started_at: "root", command: "codex" },
        {
          pid: 200,
          ppid: 100,
          started_at: "wrapper",
          command: "zsh -c 'tt wait --events --after 1 --json'"
        },
        {
          pid: 201,
          ppid: 200,
          started_at: "child",
          command: "node /bin/tt wait --events --after 1 --json"
        },
        {
          pid: 301,
          ppid: 300,
          started_at: "peer",
          command: "node /bin/tt wait --events --after 1 --json"
        }
      ]
    });

    expect(result.status).toBe("scanned");
    expect(result.processes.map((process) => process.pid)).toEqual([201]);
    expect(result.duplicate_count).toBe(0);

    const duplicate = scanReceiverProcesses(room, {
      root_pid: 100,
      read_cwd: () => project,
      process_rows: [
        { pid: 100, ppid: 1, started_at: "root", command: "codex" },
        {
          pid: 201,
          ppid: 100,
          started_at: "first",
          command: "node /bin/tt wait --events --after 1 --json"
        },
        {
          pid: 202,
          ppid: 100,
          started_at: "second",
          command: "node /bin/tt wait --events --after 1 --json"
        }
      ]
    });
    expect(duplicate.status).toBe("scanned");
    expect(duplicate.processes.map((process) => process.pid)).toEqual([
      201,
      202
    ]);
    expect(duplicate.duplicate_count).toBe(1);
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
            : "harness_cli",
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

async function passCliTestTurn(
  roomId: string,
  ownerAgentId: string,
  targetAgentId: string
): Promise<void> {
  const service = new TalkingStickService();
  try {
    const turn = await service.waitForTurn({
      agent_id: ownerAgentId,
      room_id: roomId,
      max_wait_ms: 0
    });
    expect(turn.status).toBe("your_turn");
    if (turn.status !== "your_turn") {
      throw new Error(`Expected owner turn, got ${turn.status}`);
    }

    service.passStick({
      agent_id: ownerAgentId,
      room_id: roomId,
      lease_id: turn.lease_id,
      expected_turn_id: turn.turn_id,
      to_agent_id: targetAgentId,
      handoff: {
        status: "Owner is passing.",
        next_action: "Receiver should claim."
      },
      operator_override: true
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

interface SpawnedCliProcess {
  child: ChildProcessWithoutNullStreams;
  stdout: () => string;
  stderr: () => string;
}

function snapshotCliState(): unknown {
  const service = new TalkingStickService();
  try {
    return {
      rooms: service.db
        .prepare("SELECT * FROM path_rooms ORDER BY room_id")
        .all(),
      members: service.db
        .prepare("SELECT * FROM room_members ORDER BY room_id, agent_id")
        .all(),
      events: service.db
        .prepare("SELECT * FROM room_events ORDER BY event_seq")
        .all(),
      notes: service.db
        .prepare("SELECT * FROM notes ORDER BY room_id, created_at, note_id")
        .all(),
      sessions: readCliSessions(resolveCliSessionPath())
    };
  } finally {
    service.close();
  }
}

function spawnCliProcess(
  argv: string[],
  stdin = "",
  extraEnv: NodeJS.ProcessEnv = {}
): SpawnedCliProcess {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", ...argv],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...extraEnv,
        TALKING_STICK_DISABLE_SKILL_SYNC: "1"
      },
      stdio: "pipe"
    }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end(stdin);
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr
  };
}

async function runCliProcess(
  argv: string[],
  stdin: string,
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<{ stdout: string; stderr: string }> {
  const processState = spawnCliProcess(argv, stdin, extraEnv);
  const close = await waitForProcessClose(processState.child);
  if (close.code !== 0) {
    throw new Error(
      `CLI process exited with code ${close.code}: ${processState.stderr()}`
    );
  }
  return {
    stdout: processState.stdout(),
    stderr: processState.stderr()
  };
}

async function waitForFirstStdoutLine(
  processState: SpawnedCliProcess,
  timeoutMs = 3000
): Promise<string> {
  const existing = firstLine(processState.stdout());
  if (existing) {
    return existing;
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      processState.child.kill("SIGKILL");
      reject(
        new Error(
          `Timed out waiting for stdout. stderr=${processState.stderr()}`
        )
      );
    }, timeoutMs);
    const onData = () => {
      const line = firstLine(processState.stdout());
      if (line) {
        cleanup();
        resolve(line);
      }
    };
    const onClose = () => {
      cleanup();
      reject(
        new Error(
          `CLI process closed before stdout line. stderr=${processState.stderr()}`
        )
      );
    };
    const cleanup = () => {
      clearTimeout(timer);
      processState.child.stdout.off("data", onData);
      processState.child.off("close", onClose);
    };

    processState.child.stdout.on("data", onData);
    processState.child.once("close", onClose);
  });
}

async function waitForStdoutLines(
  processState: SpawnedCliProcess,
  count: number,
  timeoutMs = 3000
): Promise<string[]> {
  const existing = stdoutLines(processState.stdout());
  if (existing.length >= count) {
    return existing.slice(0, count);
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      processState.child.kill("SIGKILL");
      reject(
        new Error(
          `Timed out waiting for ${count} stdout lines. stderr=${processState.stderr()}`
        )
      );
    }, timeoutMs);
    const onData = () => {
      const lines = stdoutLines(processState.stdout());
      if (lines.length >= count) {
        cleanup();
        resolve(lines.slice(0, count));
      }
    };
    const onClose = () => {
      cleanup();
      reject(
        new Error(
          `CLI process closed before ${count} stdout lines. stderr=${processState.stderr()}`
        )
      );
    };
    const cleanup = () => {
      clearTimeout(timer);
      processState.child.stdout.off("data", onData);
      processState.child.off("close", onClose);
    };

    processState.child.stdout.on("data", onData);
    processState.child.once("close", onClose);
  });
}

async function waitForProcessClose(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 3000
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      child.kill("SIGKILL");
      reject(new Error("Timed out waiting for CLI process to exit."));
    }, timeoutMs);
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("close", onClose);
    };

    child.once("close", onClose);
  });
}

async function releaseIfHeld(project: string, agentId: string): Promise<void> {
  try {
    await captureStdout([
      "release",
      project,
      "--agent",
      agentId,
      "--status",
      "Cleanup release.",
      "--next-action",
      "Continue.",
      "--json"
    ]);
  } catch {
    // Best-effort test cleanup; the assertion that matters already happened.
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPidIfAlive(pid: number | undefined): void {
  if (pid === undefined || !isPidAlive(pid)) {
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Best-effort test cleanup.
  }
}

async function waitForPidGone(pid: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return;
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for pid ${pid} to exit.`);
}

function firstLine(output: string): string | null {
  const line = stdoutLines(output)[0];
  return line ?? null;
}

function stdoutLines(output: string): string[] {
  return output.split("\n").filter((item) => item.length > 0);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
