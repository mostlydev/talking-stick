import { execFileSync, spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../src/process-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/process-utils.js")>();
  return {
    ...actual,
    createSystemProcessInspector(options?: Parameters<typeof actual.createSystemProcessInspector>[0]) {
      const inner = actual.createSystemProcessInspector(options);
      return {
        inspect(pid: number) {
          const info = inner.inspect(pid);
          if (!info?.command) return info;
          // CLI tests assume a non-harness host. When the suite runs inside
          // Grok, ancestry would otherwise promote every whoami/text-mode
          // assertion to grok JSON. Keep pid/startTime for liveness.
          if (/(?:^|[\\/\s])grok(?:[\s-]|$)/i.test(info.command)) {
            return { ...info, command: "node" };
          }
          return info;
        }
      };
    }
  };
});

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
  upsertCliSession,
  writeCliSessions
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
  "GROK_AGENT",
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
  "TT_ROOM",
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

let isolatedCliDataDir: string | undefined;
beforeEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  process.env.TALKING_STICK_DISABLE_SKILLER = "1";
  isolatedCliDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-cli-test-data-"));
  process.env.TALKING_STICK_DATA_DIR = isolatedCliDataDir;
});

afterEach(() => {
  if (isolatedCliDataDir) fs.rmSync(isolatedCliDataDir, { recursive: true, force: true });
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

  test("adds short hints only at authority and listener transitions", () => {
    const command = (name: string) => ({
      name,
      positionals: [],
      options: new Map<string, string | true>()
    });

    expect(
      prepareJsonResult(command("wait"), {
        status: "your_turn",
        guardian_pid: 42
      })
    ).toMatchObject({
      hint: expect.stringContaining("release or pass before stopping")
    });
    expect(
      prepareJsonResult(command("wait"), {
        status: "not_yet",
        events: [{ event_id: "event-1" }]
      })
    ).toMatchObject({
      hint: "Wait exited: process events; if work remains, start one successor."
    });
    expect(
      prepareJsonResult(command("release"), { status: "released" })
    ).toMatchObject({
      hint: expect.stringContaining("Work remains")
    });
    expect(
      prepareJsonResult(command("msg send"), { status: "sent" })
    ).not.toHaveProperty("hint");
  });

  test("compacts join policy but preserves member discovery", () => {
    const compact = prepareJsonResult(
      {
        name: "join",
        positionals: [],
        options: new Map<string, string | true>()
      },
      {
        room_id: "room-1",
        policy: { heartbeatIntervalMs: 300_000 },
        members: [
          {
            agent_id: "claude:one",
            status: "active",
            last_seen_at: "2026-08-14T22:00:00.000Z"
          }
        ]
      }
    ) as Record<string, unknown>;

    expect(compact).not.toHaveProperty("policy");
    expect(compact.members).toEqual([
      {
        agent_id: "claude:one",
        status: "active",
        last_seen_at: "2026-08-14T22:00:00.000Z"
      }
    ]);

    const verbose = prepareJsonResult(
      {
        name: "join",
        positionals: [],
        options: new Map<string, string | true>([["verbose", true]])
      },
      { policy: { heartbeatIntervalMs: 300_000 } }
    ) as Record<string, unknown>;
    expect(verbose).toHaveProperty("policy.heartbeatIntervalMs", 300_000);
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

  test("solo wait listens by default and rejects contradictory claim flags", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    const result = JSON.parse(await captureStdout([
      "wait", project, "--timeout", "0ms", "--agent", "human:solo", "--json"
    ]));
    expect(result).toMatchObject({ status: "not_yet", reason: "solo_room" });
    expect(result.guardian_pid).toBeUndefined();
    await expect(captureStdout([
      "wait", project, "--park", "--claim", "--json"
    ])).rejects.toThrow(/cannot be combined/);
  });

  test("tt wait returns a live guardian pid", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    let guardianPid: number | undefined;

    try {
      await captureStdout(["join", project, "--agent", "human:worker"]);
      const waitOut = await captureStdout([
        "wait", "--claim",
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
        "wait", "--claim",
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
        "wait", "--claim",
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
        "wait", "--claim", project, "--timeout", "0ms", "--agent", "human:worker", "--json"
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
        "wait", "--claim", project, "--timeout", "0ms", "--agent", "human:a", "--json"
      ])) as { guardian_pid: number };
      guardianPid = first.guardian_pid;

      await captureStdout(["join", project, "--agent", "human:b", "--json"]);
      await captureStdout(["try", project, "--agent", "human:a", "--json"]);

      const listener = spawnCliProcess([
        "wait", "--claim", project, "--timeout", "5s", "--agent", "human:a", "--json"
      ]);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(listener.child.exitCode).toBeNull();

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

  test("one long-running wait process exits when another member joins", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    let ownerGuardianPid: number | undefined;
    let listener: SpawnedCliProcess | undefined;
    try {
      await captureStdout(["join", project, "--agent", "human:observer"]);
      await captureStdout(["join", project, "--agent", "human:owner"]);
      const owner = JSON.parse(
        await captureStdout([
          "wait", "--claim",
          project,
          "--timeout",
          "0ms",
          "--agent",
          "human:owner",
          "--json"
        ])
      ) as { guardian_pid: number };
      ownerGuardianPid = owner.guardian_pid;

      // Consume the observer's existing join/claim backlog so this exercises a
      // genuinely live membership change rather than replaying old events.
      await captureStdout([
        "try",
        project,
        "--agent",
        "human:observer",
        "--json"
      ]);

      listener = spawnCliProcess([
        "wait", "--claim",
        project,
        "--timeout",
        "5s",
        "--agent",
        "human:observer",
        "--json"
      ]);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(listener.child.exitCode).toBeNull();

      await captureStdout(["join", project, "--agent", "human:new-peer", "--json"]);

      const close = await waitForProcessClose(listener.child, 5_000);
      expect(close.code).toBe(0);
      const result = JSON.parse(listener.stdout()) as {
        wake_reason: string;
        events: Array<{ event_type: string; from_agent_id?: string }>;
      };
      expect(result.wake_reason).toBe("event");
      expect(result.events).toContainEqual(
        expect.objectContaining({
          event_type: "join",
          from_agent_id: "human:new-peer"
        })
      );
    } finally {
      if (listener?.child.exitCode === null) listener.child.kill("SIGTERM");
      await releaseIfHeld(project, "human:owner");
      killPidIfAlive(ownerGuardianPid);
      for (const agent of ["human:new-peer", "human:observer"]) {
        try {
          await captureStdout(["leave", project, "--agent", agent, "--json"]);
        } catch {
          // best-effort fixture cleanup
        }
      }
    }
  });

  test("health reports the registered wait and a duplicate wait is rejected", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    let guardianPid: number | undefined;
    let listener: SpawnedCliProcess | undefined;
    try {
      const first = JSON.parse(await captureStdout([
        "wait", "--claim", project, "--timeout", "0ms", "--agent", "human:receiver", "--json"
      ])) as { guardian_pid: number };
      guardianPid = first.guardian_pid;

      listener = spawnCliProcess([
        "wait", "--claim", project, "--timeout", "5s", "--agent", "human:receiver", "--json"
      ]);
      const health = await waitForActiveListener(
        project,
        "human:receiver",
        listener
      );
      expect(health.listener).toEqual({
        status: "registered",
        active: true,
        duplicates: 0
      });

      const duplicate = spawnCliProcess([
        "wait", "--claim", project, "--timeout", "5s", "--agent", "human:receiver", "--json"
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
        "wait", "--claim",
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
        "wait", "--claim",
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
        "wait", "--claim",
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
        "wait", "--claim",
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

  test("tt standby defaults to manual when the inherited cmux endpoint is unreachable", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    const fakeBin = path.join(path.dirname(project), "fake-bin");
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeCmux = path.join(fakeBin, "cmux");
    fs.writeFileSync(
      fakeCmux,
      "#!/bin/sh\necho 'stale cmux socket' >&2\nexit 1\n"
    );
    fs.chmodSync(fakeCmux, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ""}`;
    process.env.CMUX_TAB_ID = "inherited-tab";

    try {
      const output = JSON.parse(await captureStdout([
        "standby",
        project,
        "--agent",
        "human:parked",
        "--json"
      ])) as {
        transport: string;
        can_self_wake: boolean;
        fallback_reason?: string;
      };

      expect(output).toMatchObject({
        transport: "manual",
        can_self_wake: false
      });
      expect(output).not.toHaveProperty("fallback_reason");
    } finally {
      process.env.PATH = originalPath;
      delete process.env.CMUX_TAB_ID;
    }
  });

  test("tt standby omits unavailable cmux diagnostics in automatic mode", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    const output = JSON.parse(await captureStdout([
      "standby", project, "--agent", "human:parked", "--json"
    ]));
    expect(output).toMatchObject({ status: "standby_registered", transport: "manual", can_self_wake: false, wake_transports: [] });
    expect(output).not.toHaveProperty("fallback_reason");
    const plain = await captureStdout(["standby", project, "--agent", "human:parked"]);
    expect(plain).not.toContain("cmux");
    expect(plain).toContain("cannot self-wake");
  });

  test("tt standby keeps an explicit --wake cmux request strict", async () => {
    const { project } = setupIsolatedCli(tempDirs);

    await expect(captureStdout([
      "standby",
      project,
      "--wake",
      "cmux",
      "--agent",
      "human:parked",
      "--json"
    ])).rejects.toThrow("No cmux caller context is available");
  });

  // Issue #67: an unreachable cmux socket must never reach JSON stdout, even
  // when the cmux binary itself writes its error there. Real subprocesses,
  // so a child inheriting the CLI's stdout would show up here.
  test("--json stdout stays parseable when cmux prints socket errors", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    const fakeBin = path.join(path.dirname(project), "fake-bin");
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "cmux"),
      "#!/bin/sh\necho 'Error: cmux socket not found'\necho 'Error: cmux socket not found' >&2\nexit 1\n");
    fs.chmodSync(path.join(fakeBin, "cmux"), 0o755);
    const env = { PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`, CMUX_TAB_ID: "tab-1", CMUX_AGENT_LAUNCH_KIND: "claude" };
    const agent = ["--agent", "human:watcher", "--json"];

    for (const argv of [["join", project], ["standby", project], ["msg", "send", "room", "hello", "--in", project], ["state", project], ["health", project]]) {
      const { stdout } = await runCliProcess([...argv, ...agent], "", env);
      expect(stdout).not.toContain("cmux socket");
      expect(() => JSON.parse(stdout)).not.toThrow();
    }

    const strict = spawnCliProcess(["standby", project, "--wake", "cmux", ...agent], "", env);
    expect((await waitForProcessClose(strict.child)).code).not.toBe(0);
    expect(strict.stdout()).toBe("");
    expect(strict.stderr()).toContain("Unable to verify the caller's cmux surface");
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
    ])).rejects.toThrow(/No reachable room member[\s\S]*--operator-requested/);

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
    ])).rejects.toThrow(/No reachable room member[\s\S]*--operator-requested/);
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

  test("tt join from a nested workspace root discovers the parent room and members", async () => {
    const { dataDir, project } = setupIsolatedCli(tempDirs);
    const nestedProject = path.join(project, "repos", "child");
    fs.mkdirSync(nestedProject, { recursive: true });
    fs.writeFileSync(path.join(nestedProject, "package.json"), "{}\n");

    const parent = JSON.parse(
      await captureStdout([
        "join",
        project,
        "--agent",
        "human:parent",
        "--json"
      ])
    ) as { room_id: string };
    const nested = JSON.parse(
      await captureStdout([
        "join",
        nestedProject,
        "--agent",
        "human:child",
        "--json"
      ])
    ) as {
      room_id: string;
      canonical_path: string;
      members: Array<{ agent_id: string }>;
      policy?: unknown;
      hint: string;
    };

    expect(nested.room_id).toBe(parent.room_id);
    expect(nested.canonical_path).toBe(project);
    expect(nested.members.map((member) => member.agent_id).sort()).toEqual([
      "human:child",
      "human:parent"
    ]);
    expect(nested.policy).toBeUndefined();
    expect(nested.hint).toContain("expected peers are listed in members");
    expect(fs.existsSync(path.join(dataDir, "cli-sessions.json"))).toBe(true);
  });
});

describe("stale room sessions", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  test.each(["state", "notes"])("%s recovers from a deleted cached room", async (command) => {
    const { project } = setupIsolatedCli(tempDirs);
    const old = JSON.parse(await captureStdout(["join", project, "--agent", "human:old", "--json"]));
    const stale = readCliSessions(resolveCliSessionPath()).find((session) => session.agent_id === "human:old")!;
    await captureStdout(["leave", project, "--agent", "human:old", "--json"]);
    const live = JSON.parse(await captureStdout(["join", project, "--agent", "human:live", "--json"]));
    expect(live.room_id).not.toBe(old.room_id);
    upsertCliSession(resolveCliSessionPath(), { ...stale, lease_id: "stale-lease", event_cursor_seq: 999 });

    const args = command === "notes"
      ? ["notes", "list", "--path", project]
      : [command, project];
    const result = JSON.parse(await captureStdout([...args, "--agent", "human:old", "--json"]));
    if (command === "notes") expect(result.notes).toEqual([]);
    else expect(result.room.room_id).toBe(live.room_id);
    const healed = readCliSessions(resolveCliSessionPath()).filter((session) => session.agent_id === "human:old");
    expect(healed).toHaveLength(1);
    expect(healed[0].room_id).toBe(live.room_id);
    expect(healed[0].lease_id).toBeUndefined();
    expect(healed[0].event_cursor_seq).toBeUndefined();
  });

  test("a deleted nested cache falls back to a live ancestor without losing its lease", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    const nested = path.join(project, "child");
    fs.mkdirSync(nested);
    const joined = JSON.parse(await captureStdout(["join", project, "--agent", "human:worker", "--json"]));
    const sessionPath = resolveCliSessionPath();
    const parent = { ...readCliSessions(sessionPath)[0], lease_id: "live-lease", event_cursor_seq: 42 };
    writeCliSessions(sessionPath, [parent, {
      ...parent, canonical_path: nested, room_id: "deleted-child", lease_id: "stale-lease"
    }]);
    const result = JSON.parse(await captureStdout(["state", nested, "--agent", "human:worker", "--json"]));
    expect(result.room.room_id).toBe(joined.room_id);
    expect(readCliSessions(sessionPath)).toEqual([parent]);
  });


  test("a concurrent join after the room snapshot preserves its replacement session", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    const live = JSON.parse(await captureStdout(["join", project, "--agent", "human:live", "--json"]));
    const sessionPath = resolveCliSessionPath();
    const base = { agent_id: "human:reader", canonical_path: project, workspace_root: project, updated_at: new Date().toISOString() };
    upsertCliSession(sessionPath, { ...base, room_id: "deleted" });
    const replacement = { ...base, room_id: live.room_id, lease_id: "fresh-lease", event_cursor_seq: 42 };
    const original = TalkingStickService.prototype.listRooms;
    let firstSnapshot = true;
    const spy = vi.spyOn(TalkingStickService.prototype, "listRooms").mockImplementation(function (this: TalkingStickService, input) {
      if (firstSnapshot) {
        firstSnapshot = false;
        // The new room/session arrived after the service took this snapshot.
        upsertCliSession(sessionPath, replacement);
        return { rooms: [] };
      }
      return original.call(this, input);
    });
    try {
      const result = JSON.parse(await captureStdout(["state", project, "--agent", "human:reader", "--json"]));
      expect(result.room.room_id).toBe(live.room_id);
      expect(readCliSessions(sessionPath).find((session) => session.agent_id === "human:reader")).toEqual(replacement);
    } finally {
      spy.mockRestore();
    }
  });


  test("room discovery does not overwrite a concurrent join with an older snapshot", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    const live = JSON.parse(await captureStdout(["join", project, "--agent", "human:live", "--json"]));
    const sessionPath = resolveCliSessionPath();
    const replacement = { agent_id: "human:reader", canonical_path: project, workspace_root: project,
      updated_at: new Date().toISOString(), room_id: live.room_id, lease_id: "fresh-lease", event_cursor_seq: 42 };
    const original = TalkingStickService.prototype.listRooms;
    let firstSnapshot = true;
    const spy = vi.spyOn(TalkingStickService.prototype, "listRooms").mockImplementation(function (this: TalkingStickService, input) {
      const result = original.call(this, input);
      if (firstSnapshot) {
        firstSnapshot = false;
        upsertCliSession(sessionPath, replacement);
        return { rooms: result.rooms.map((room) => ({ ...room, room_id: "deleted-snapshot" })) };
      }
      return result;
    });
    try {
      const result = JSON.parse(await captureStdout(["state", project, "--agent", "human:reader", "--json"]));
      expect(result.room.room_id).toBe(live.room_id);
      expect(readCliSessions(sessionPath).find((session) => session.agent_id === "human:reader")).toEqual(replacement);
    } finally {
      spy.mockRestore();
    }
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
        "wait", "--claim",
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
    expect(result.text).toContain("Default role: precise implementation");
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
    expect(result.text).toContain(
      "Default role: fast implementation and cross-checks"
    );
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
    expect(out).toContain(".grok/hooks/talking-stick-inbox.json");
    expect(out).toContain(".grok/hooks/talking-stick-stop.json");
    const noGuard = await captureStdout(["install", "grok", "--no-guard", "--print"]);
    expect(noGuard).toContain(".grok/hooks/talking-stick-inbox.json");
    expect(noGuard).not.toContain(".grok/hooks/talking-stick-stop.json");
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

  test("tt uninstall claude removes the managed Stop guard without skiller", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-uninstall-claude-home-"));
    tempDirs.push(home);
    const claudeDir = path.join(home, ".claude");
    const settingsPath = path.join(claudeDir, "settings.json");
    fs.mkdirSync(claudeDir, { recursive: true });

    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      await captureStdout(["install", "claude", "--copy", "--replace"]);
      expect(fs.readFileSync(settingsPath, "utf8")).toContain(
        "talking-stick-claude-stop-hook"
      );
      expect(fs.readFileSync(settingsPath, "utf8")).toContain("talking-stick-lifecycle-claude");

      await captureStdout(["uninstall", "claude"]);
      expect(fs.readFileSync(settingsPath, "utf8")).not.toContain(
        "talking-stick-claude-stop-hook"
      );
      expect(fs.readFileSync(settingsPath, "utf8")).not.toContain("talking-stick-lifecycle-claude");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
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
      const events = service
        .getRoomEvents({ room_id: roomId })
        .filter((event) => event.event_type === "message_sent");
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
      const events = service
        .getRoomEvents({ room_id: roomId })
        .filter((event) => event.event_type === "message_sent");
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

  test("tt --version prints the package version", async () => {
    setupIsolatedCli(tempDirs);
    const { version } = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version: string };
    expect(JSON.parse(await captureStdout(["--version", "--json"]))).toEqual({ version });
  });

  test("tt msg send --attach stores the image and sends it, with or without text", async () => {
    const { project, dataDir } = setupIsolatedCli(tempDirs);
    const roomId = seedCliRoomMembers(project, [
      { agent_id: "human:sender", display_name: "sender" },
      { agent_id: "codex:target", display_name: "codex" }
    ]);
    const image = path.join(project, "shot.png");
    fs.writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));

    await captureStdout(["msg", "send", "room", "look", "--attach", image, "--agent", "human:sender", "--path", project, "--json"]);
    await captureStdout(["msg", "send", "codex:target", "--attach", image, "--agent", "human:sender", "--path", project, "--json"]);
    await expect(captureStdout(["msg", "send", "room", "--attach", path.join(project, "package.json"),
      "--agent", "human:sender", "--path", project, "--json"])).rejects.toThrow(/PNG, JPEG, GIF, and WebP/);

    const service = new TalkingStickService();
    try {
      const sent = service.getRoomEvents({ room_id: roomId }).filter((event) => event.event_type === "message_sent");
      expect(sent.map((event) => event.payload?.body)).toEqual(["look", ""]);
      const attachments = sent.map((event) => event.payload!.attachments![0]);
      expect(attachments[0].path.startsWith(path.join(dataDir, "attachments") + path.sep)).toBe(true);
      expect(attachments[0].name).toBe("shot.png");
      expect(attachments[1].path).toBe(attachments[0].path);
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
      const event = service
        .getRoomEvents({ room_id: roomId })
        .find((candidate) => candidate.event_type === "message_sent");
      expect(event).toMatchObject({
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
      const event = service
        .getRoomEvents({ room_id: roomId })
        .find((candidate) => candidate.event_type === "message_sent");
      expect(event).toMatchObject({
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

  test("a rejected pre-join message does not create CLI session state", async () => {
    const { dataDir, project } = setupIsolatedCli(tempDirs);
    seedCliRoomMembers(project, [
      { agent_id: "codex:target", display_name: "codex" }
    ]);

    await expect(
      captureStdout([
        "msg",
        "send",
        "codex",
        "hello",
        "--agent",
        "human:not-joined",
        "--path",
        project
      ])
    ).rejects.toMatchObject({
      code: "unknown_member",
      details: { agent_id: "human:not-joined" }
    });

    expect(
      readCliSessions(resolveCliSessionPath({ dataDir })).some(
        (session) => session.agent_id === "human:not-joined"
      )
    ).toBe(false);
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
      const event = service
        .getRoomEvents({ room_id: roomId })
        .find((candidate) => candidate.event_type === "message_sent");
      expect(event).toMatchObject({
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
      const events = service
        .getRoomEvents({ room_id: roomId })
        .filter((event) => event.event_type === "message_sent");
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

  test("tt events --follow stops promptly mid long-poll and reports its cursor", async () => {
    const { project } = setupIsolatedCli(tempDirs);
    const roomId = seedCliRoomMembers(project, [{ agent_id: "human:sender", display_name: "sender" }]);
    sendCliTestMessage(roomId, "human:sender", null, "before the watch");
    const service = new TalkingStickService();
    const head = service.getLatestEventSeq({ room_id: roomId });
    service.close();
    // No --timeout: the default long-poll lasts 110s, which SIGTERM must cut short.
    const watcher = spawnCliProcess(["events", project, "--follow", "--after", String(head), "--target", "any",
      "--agent", "human:watcher", "--json"]);
    sendCliTestMessage(roomId, "human:sender", null, "live");
    const event = JSON.parse(await waitForFirstStdoutLine(watcher));
    expect(event.payload.body).toBe("live");

    const started = Date.now();
    const closePromise = waitForProcessClose(watcher.child);
    watcher.child.kill("SIGTERM");
    expect(await closePromise).toMatchObject({ code: 0, signal: null });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(watcher.stderr()).toContain(`cursor_event_seq=${event.event_seq}`);
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
      "--event",
      "message_sent",
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
      "--event",
      "message_sent,pass",
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
      "--event",
      "message_sent,pass",
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

describe("tt room", () => {
  test("ensure is idempotent, validates an existing declaration, and never rewrites it", async () => {
    const registry: string[] = [];
    const { project } = setupIsolatedCli(registry);
    execFileSync("git", ["init", "-q", "-b", "main", project]);
    const session = path.join(project, "sessions", "s1");
    fs.mkdirSync(session, { recursive: true });
    process.env.TT_HARNESS_AGENT_ID = "claude:ensure";

    const created = JSON.parse(await captureStdout(["room", "ensure", session, "--name", "s1", "--json"]));
    expect(created).toMatchObject({ status: "created", room_path: session, name: "s1",
      declaration: path.join(session, ".talking-stick", "room.toml") });
    const again = JSON.parse(await captureStdout(["room", "ensure", session, "--name", "s1", "--json"]));
    expect(again).toMatchObject({ status: "exists", room_id: created.room_id, room_path: session });
    // No name asks only for a room; the declared name is reported.
    expect(JSON.parse(await captureStdout(["room", "ensure", session, "--json"]))).toMatchObject({ status: "exists", name: "s1" });
    await expect(captureStdout(["room", "ensure", session, "--name", "other", "--json"])).rejects.toThrow(/already declares the room name "s1"/);
    await expect(captureStdout(["room", "ensure", path.join(project, "missing"), "--json"])).rejects.toThrow(/not a directory/);

    // Content tt does not understand still declares the room; it is reported, never replaced.
    const odd = path.join(project, "sessions", "odd");
    fs.mkdirSync(path.join(odd, ".talking-stick"), { recursive: true });
    fs.writeFileSync(path.join(odd, ".talking-stick", "room.toml"), "owner = \"someone\"\n");
    expect(JSON.parse(await captureStdout(["room", "ensure", odd, "--json"])))
      .toMatchObject({ status: "exists", room_path: odd, warning: expect.stringMatching(/not understood/) });
    await expect(captureStdout(["room", "ensure", odd, "--name", "odd", "--json"])).rejects.toThrow(/without a name/);
    expect(fs.readFileSync(path.join(odd, ".talking-stick", "room.toml"), "utf8")).toBe("owner = \"someone\"\n");

    // Concurrent launches declare one room and agree on it.
    const racing = path.join(project, "sessions", "s2");
    fs.mkdirSync(racing);
    const runs = [0, 1, 2].map(() => spawnCliProcess(["room", "ensure", racing, "--name", "s2", "--json"]));
    const codes = await Promise.all(runs.map((run) => new Promise<number | null>((resolve) => run.child.on("close", resolve))));
    expect(codes, runs.map((run) => run.stderr()).join("\n")).toEqual([0, 0, 0]);
    const results = runs.map((run) => JSON.parse(run.stdout()));
    expect(new Set(results.map((result) => result.room_id)).size).toBe(1);
    expect(results.filter((result) => result.status === "created")).toHaveLength(1);
    expect(fs.readdirSync(path.join(racing, ".talking-stick"))).toEqual(["room.toml"]);
    for (const dir of registry) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a launcher's path pin reopens an emptied room on join, and --in still wins", async () => {
    const registry: string[] = [];
    const { project } = setupIsolatedCli(registry);
    execFileSync("git", ["init", "-q", "-b", "main", project]);
    const session = path.join(project, "sessions", "s1");
    fs.mkdirSync(session, { recursive: true });
    process.env.TT_HARNESS_AGENT_ID = "claude:pinned";
    const ensured = JSON.parse(await captureStdout(["room", "ensure", session, "--json"]));

    try {
      // The launcher keeps the umbrella as the working directory.
      process.env.TT_ROOM = ensured.room_path;
      const first = JSON.parse(await captureStdout(["join", project, "--json"]));
      expect(first).toMatchObject({ room_id: ensured.room_id, canonical_path: session });
      await captureStdout(["leave", "--json"]);
      // The last agent left, so the room row is gone; a read says how to recover.
      await expect(captureStdout(["state", "--json"])).rejects.toThrow(/`tt join` reopens it/);
      const reopened = JSON.parse(await captureStdout(["join", project, "--json"]));
      expect(reopened.canonical_path).toBe(session);
      expect(reopened.room_id).not.toBe(ensured.room_id);
      // An ephemeral id never reopens.
      await captureStdout(["leave", "--json"]);
      process.env.TT_ROOM = reopened.room_id;
      await expect(captureStdout(["join", project, "--json"])).rejects.toThrow(/No open room matches/);
      process.env.TT_ROOM = ensured.room_path;

      // --in wins over TT_ROOM for that command, even over a stale one.
      process.env.TT_ROOM = "00000000-0000-4000-8000-000000000000";
      const explicit = JSON.parse(await captureStdout(["join", project, "--in", ensured.room_path, "--json"]));
      expect(explicit.canonical_path).toBe(session);
      await captureStdout(["leave", "--in", ensured.room_path, "--json"]);
      process.env.TT_ROOM = ensured.room_path;

      // A declaration removed under the pin is not reopened.
      fs.rmSync(path.join(session, ".talking-stick"), { recursive: true });
      await expect(captureStdout(["join", project, "--json"])).rejects.toThrow(/No open room matches/);
    } finally {
      delete process.env.TT_ROOM;
      for (const dir of registry) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a pinned agent working in a nested linked worktree joins only the pinned room", async () => {
    const registry: string[] = [];
    const { project, dataDir } = setupIsolatedCli(registry);
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
    execFileSync("git", ["init", "-q", "-b", "main", project]);
    const base = path.join(dataDir, "base");
    execFileSync("git", ["init", "-q", "-b", "main", base]);
    git(base, "config", "user.name", "Test"); git(base, "config", "user.email", "t@example.com");
    fs.writeFileSync(path.join(base, "README"), "x\n");
    git(base, "add", "-A"); git(base, "commit", "-q", "-m", "init");
    const session = path.join(project, "sessions", "s1");
    fs.mkdirSync(session, { recursive: true });
    const mount = path.join(session, "mounts", "base");
    git(base, "worktree", "add", "-q", "-b", "session-s1", mount);
    process.env.TT_HARNESS_AGENT_ID = "codex:mounted";
    const ensured = JSON.parse(await captureStdout(["room", "ensure", session, "--json"]));

    const cwd = process.cwd();
    try {
      process.env.TT_ROOM = ensured.room_path;
      process.chdir(mount);
      const joined = JSON.parse(await captureStdout(["join", "--json"]));
      expect(joined.room_id).toBe(ensured.room_id);
      const memberships = new TalkingStickService();
      try {
        const rooms = memberships.listRooms({}).rooms.filter((room) =>
          memberships.getRoomState({ room_id: room.room_id }).members.some((member) => member.agent_id === "codex:mounted"));
        expect(rooms.map((room) => room.canonical_path)).toEqual([session]);
      } finally {
        memberships.close();
      }
    } finally {
      process.chdir(cwd);
      delete process.env.TT_ROOM;
      for (const dir of registry) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("create declares a room that join, --room, and list agree on", async () => {
    const registry: string[] = [];
    const { project } = setupIsolatedCli(registry);
    execFileSync("git", ["init", "-q", "-b", "main", project]);
    const api = path.join(project, "packages", "api");
    fs.mkdirSync(path.join(api, "src"), { recursive: true });
    process.env.TT_HARNESS_AGENT_ID = "claude:rooms";

    const created = JSON.parse(await captureStdout(["room", "create", api, "--name", "api", "--json"]));
    expect(created).toMatchObject({ status: "created", rel_path: "packages/api", name: "api" });
    expect(fs.readFileSync(path.join(api, ".talking-stick", "room.toml"), "utf8")).toContain('name = "api"');
    await expect(captureStdout(["room", "create", api, "--json"])).rejects.toThrow(/already declares/);
    // Selectable by name before any agent has joined from inside it.
    expect(JSON.parse(await captureStdout(["state", "--in", "#api", "--json"])).room.room_id).toBe(created.room_id);

    const root = JSON.parse(await captureStdout(["join", project, "--json"]));
    const fromSrc = JSON.parse(await captureStdout(["join", path.join(api, "src"), "--json"]));
    expect(fromSrc.canonical_path).toBe(api);
    expect(fromSrc.room_id).toBe(created.room_id);
    expect(fromSrc.room_id).not.toBe(root.room_id);

    process.env.TT_HARNESS_AGENT_ID = "codex:rooms";
    const byName = JSON.parse(await captureStdout(["join", project, "--in", "#api", "--json"]));
    expect(byName.room_id).toBe(fromSrc.room_id);
    process.env.TT_ROOM = root.room_id;
    expect(JSON.parse(await captureStdout(["join", path.join(api, "src"), "--json"])).room_id).toBe(root.room_id);
    delete process.env.TT_ROOM;
    await expect(captureStdout(["join", project, "--in", "#nope", "--json"])).rejects.toThrow(/No open room matches/);

    const listed = JSON.parse(await captureStdout(["room", "list", project, "--json"]));
    expect(listed.rooms.map((room: { name: string; kind: string }) => [room.name, room.kind]).sort())
      .toEqual([["api", "declared"], ["root", "root"]]);
    const apiListing = listed.rooms.find((room: { name: string }) => room.name === "api");
    // codex joined #api, then root through TT_ROOM: an agent is in one room
    // per repository, so it moved out of #api.
    expect(apiListing.agents.sort()).toEqual(["claude:rooms"]);
    expect(listed.rooms.find((room: { name: string }) => room.name === "root").agents).toEqual(["codex:rooms"]);
    expect(JSON.parse(await captureStdout(["room", "list", path.join(api, "src"), "--json"])).rooms
      .find((room: { current: boolean }) => room.current).name).toBe("api");
    // A room selected in another repository lists that repository.
    const elsewhere = path.join(path.dirname(project), "elsewhere");
    fs.mkdirSync(elsewhere);
    execFileSync("git", ["init", "-q", "-b", "main", elsewhere]);
    const otherRoot = JSON.parse(await captureStdout(["join", elsewhere, "--json"]));
    const crossRepo = JSON.parse(await captureStdout(["room", "list", project, "--in", otherRoot.room_id, "--json"]));
    expect(crossRepo.anchor).toBe(fs.realpathSync.native(elsewhere));
    expect(crossRepo.rooms.map((room: { current: boolean; name: string }) => [room.name, room.current])).toEqual([["root", true]]);
    await captureStdout(["leave", "--in", otherRoot.room_id, "--json"]);
    process.env.TT_ROOM = otherRoot.room_id; // now stale: the room was deleted on leave
    expect(JSON.parse(await captureStdout(["room", "list", project, "--json"])).anchor).toBe(project);
    delete process.env.TT_ROOM;
    expect(JSON.parse(await captureStdout(["state", "--in", "#root", "--path", path.join(api, "src"), "--json"])).room.room_id)
      .toBe(root.room_id);

    // An explicit selector never trusts a stale path-keyed session.
    const sessionsFile = path.join(process.env.TALKING_STICK_DATA_DIR!, "cli-sessions.json");
    const sessions = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
    const list = Array.isArray(sessions) ? sessions : sessions.sessions;
    const stale = list.find((entry: { agent_id: string; canonical_path: string }) =>
      entry.agent_id === "codex:rooms" && entry.canonical_path === api);
    stale.room_id = "00000000-0000-4000-8000-000000000000";
    fs.writeFileSync(sessionsFile, JSON.stringify(sessions));
    expect(JSON.parse(await captureStdout(["state", "--in", "api", "--json"])).room.room_id).toBe(fromSrc.room_id);

    await expect(captureStdout(["room", "remove", api, "--json"])).rejects.toThrow(/still has members/);
    expect(fs.existsSync(path.join(api, ".talking-stick", "room.toml"))).toBe(true);
    // codex already moved to root, so claude is the last agent in #api.
    process.env.TT_HARNESS_AGENT_ID = "claude:rooms";
    await captureStdout(["leave", "--in", "api", "--json"]);
    process.env.TT_HARNESS_AGENT_ID = "codex:rooms";
    const removed = JSON.parse(await captureStdout(["room", "remove", path.join(api, "src"), "--json"]));
    // The last agent leaving already deleted the room; remove retires it otherwise.
    expect(removed.status).toBe("removed");
    expect(fs.existsSync(path.join(api, ".talking-stick"))).toBe(false);
    process.env.TT_HARNESS_AGENT_ID = "grok:after";
    expect(JSON.parse(await captureStdout(["join", path.join(api, "src"), "--json"])).room_id).toBe(root.room_id);
    for (const dir of registry) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("list --all shows every occupied room on the host without joining or refreshing", async () => {
    const registry: string[] = [];
    const { project } = setupIsolatedCli(registry);
    const other = path.join(path.dirname(project), "other");
    const empty = path.join(path.dirname(project), "empty");
    for (const dir of [other, empty]) fs.mkdirSync(dir);
    await seedCliLease(project, "claude:host");
    await captureStdout(["release", project, "--agent", "claude:host", "--status", `Shipped ${"x".repeat(400)}`,
      "--next-action", "Review it.", "--json"]);
    const first = JSON.parse(await captureStdout(["state", project, "--agent", "human:observer", "--json"])).room;
    process.env.TT_HARNESS_AGENT_ID = "codex:host";
    const second = JSON.parse(await captureStdout(["join", other, "--json"]));
    // A room whose only agent left disappears from the listing.
    process.env.TT_HARNESS_AGENT_ID = "grok:host";
    await captureStdout(["join", empty, "--json"]);
    await captureStdout(["leave", empty, "--json"]);
    const service = new TalkingStickService();
    try {
      service.joinPath({ agent_id: "human:op:chat:1", context_path: other,
        process_metadata: { host_id: "elsewhere", pid: 10, process_started_at: "t", session_kind: "human_chat", display_name: "op" } });
    } finally {
      service.close();
    }
    const seenBefore = JSON.parse(await captureStdout(["state", project, "--agent", "human:observer", "--json"]))
      .members.find((member: { agent_id: string }) => member.agent_id === "claude:host").last_seen_at;

    process.env.TT_HARNESS_AGENT_ID = "claude:observer";
    await new Promise((resolve) => setTimeout(resolve, 5));
    const listed = JSON.parse(await captureStdout(["room", "list", "--all", "--json"]));
    expect(listed.rooms.map((room: { room_id: string }) => room.room_id).sort())
      .toEqual([first.room_id, second.room_id].sort());
    const projectRoom = listed.rooms.find((room: { room_id: string }) => room.room_id === first.room_id);
    expect(projectRoom).toMatchObject({ canonical_path: project, agents: ["claude:host"], consoles: [], owner: null });
    expect(projectRoom.last_handoff).toMatchObject({ event_type: "release", from_agent_id: "claude:host", next_action: "Review it." });
    expect(projectRoom.last_handoff.status).toHaveLength(160);
    expect(projectRoom.last_handoff.status.endsWith("…")).toBe(true);
    expect(listed.rooms.find((room: { room_id: string }) => room.room_id === second.room_id))
      .toMatchObject({ agents: ["codex:host"], consoles: ["human:op:chat:1"], last_handoff: null });

    // The observer joined nothing, and listing refreshed nobody's presence.
    const state = JSON.parse(await captureStdout(["state", project, "--agent", "human:observer", "--json"]));
    expect(state.members.map((member: { agent_id: string }) => member.agent_id)).toEqual(["claude:host"]);
    expect(state.members[0].last_seen_at).toBe(seenBefore);
    const text = await captureStdout(["room", "list", "--all", "--text"]);
    expect(text).toContain(`#project  claude:host  active`);
    expect(text).toContain("#other  codex:host, 1 console");
    for (const dir of registry) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("list --all keeps live members by liveness, not recency, and orders rooms newest first", async () => {
    const registry: string[] = [];
    const { project } = setupIsolatedCli(registry);
    const [stale, older] = ["stale", "older"].map((name) => {
      const dir = path.join(path.dirname(project), name);
      fs.mkdirSync(dir);
      return fs.realpathSync.native(dir);
    });
    const alive = deriveHumanCliIdentity({ agentId: "claude:alive", sessionKind: "human_guardian" });
    const deadPid = spawnSync("true").pid;
    const service = new TalkingStickService();
    const db = (service as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db;
    const long = "2001-01-01T00:00:00.000Z";
    try {
      const projectRoom = service.joinPath({ agent_id: alive.agent_id, context_path: project, process_metadata: alive.process_metadata });
      // A dead pid seen recently is not yet reaped, but is not a live member.
      service.joinPath({ agent_id: "codex:gone", context_path: project,
        process_metadata: { ...alive.process_metadata, pid: deadPid, display_name: "gone" } });
      // Unknown liveness needs recent presence.
      const staleRoom = service.joinPath({ agent_id: "grok:silent", context_path: stale,
        process_metadata: { host_id: "elsewhere", pid: 10, process_started_at: "t", session_kind: "human_guardian", display_name: "silent" } });
      const olderRoom = service.joinPath({ agent_id: "codex:recent", context_path: older,
        process_metadata: { host_id: "elsewhere", pid: 11, process_started_at: "t", session_kind: "human_guardian", display_name: "recent" } });
      // claude:alive has been silent for years but its process still runs.
      db.prepare("UPDATE room_members SET last_seen_at = ?, last_wait_at = NULL WHERE agent_id IN (?, ?)")
        .run(long, alive.agent_id, "grok:silent");
      db.prepare("UPDATE path_rooms SET updated_at = ? WHERE room_id = ?").run(long, olderRoom.room_id);
      // An expired lease must not read as someone working.
      db.prepare("UPDATE path_rooms SET owner = ?, lease_expires_at = ? WHERE room_id = ?").run(alive.agent_id, long, projectRoom.room_id);
      db.prepare("UPDATE room_events SET created_at = ? WHERE room_id = ?").run(long, olderRoom.room_id);
      expect(staleRoom.room_id).not.toBe(projectRoom.room_id);
    } finally {
      service.close();
    }

    const listed = JSON.parse(await captureStdout(["room", "list", "--all", "--json"]));
    expect(listed.rooms.map((room: { canonical_path: string; agents: string[] }) => [room.canonical_path, room.agents]))
      .toEqual([[project, ["claude:alive"]], [older, ["codex:recent"]]]);
    expect(listed.rooms[0]).toMatchObject({ owner: "claude:alive", state: "stale_owner" });
    expect(await captureStdout(["room", "list", "--all", "--text"])).toContain("stick=claude:alive (stale)");
    for (const dir of registry) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("brief summarizes another room for an outsider without joining it", async () => {
    const registry: string[] = [];
    const { project } = setupIsolatedCli(registry);
    const outside = path.join(path.dirname(project), "outside");
    fs.mkdirSync(outside);
    await seedCliLease(project, "claude:brief", ["codex:brief"]);
    await captureStdout(["msg", "send", "codex:brief", `long ${"y".repeat(1500)}`, "--agent", "claude:brief", "--path", project, "--json"]);
    await captureStdout(["notes", "add", "Watch the migration", "--agent", "claude:brief", "--path", project, "--json"]);
    const fullStatus = `Built the parser. ${"z".repeat(300)}`;
    await captureStdout(["release", project, "--agent", "claude:brief", "--status", fullStatus, "--next-action", "Review the parser.", "--json"]);
    for (const n of [1, 2, 3]) {
      await captureStdout(["msg", "send", "room", `update ${n}`, "--agent", "codex:brief", "--path", project, "--json"]);
    }
    const service = new TalkingStickService();
    const db = (service as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db;
    try {
      const roomId = service.listRooms({ context_path: project }).rooms[0].room_id;
      // Silent with unknown liveness: inactive, not gone.
      service.joinPath({ agent_id: "grok:silent", context_path: project,
        process_metadata: { host_id: "elsewhere", pid: 10, process_started_at: "t", session_kind: "human_guardian", display_name: "silent" } });
      db.prepare("UPDATE room_members SET last_seen_at = ?, last_wait_at = NULL WHERE agent_id = ?").run("2001-01-01T00:00:00.000Z", "grok:silent");
      // More open notes than any page: the brief shows the newest ten and the real count.
      const base = Date.now() + 60_000;
      for (let n = 0; n < 205; n += 1) {
        const added = service.addNote({ agent_id: "codex:brief", room_id: roomId, body: `note ${n}` });
        db.prepare("UPDATE notes SET created_at = ? WHERE note_id = ?").run(new Date(base + n).toISOString(), added.note_id);
      }
    } finally {
      service.close();
    }
    const before = JSON.parse(await captureStdout(["state", project, "--agent", "human:observer", "--json"]));
    // A local directory named like the room must not hijack the selector.
    fs.mkdirSync(path.join(outside, "project"));
    const run = (command: string) => captureStdout(command.split(" ").slice(1));

    const cwd = process.cwd();
    process.chdir(outside);
    try {
      process.env.TT_HARNESS_AGENT_ID = "claude:outsider";
      const brief = JSON.parse(await captureStdout(["room", "brief", "project", "--json"]));
      expect(brief).toMatchObject({ room_id: before.room.room_id, canonical_path: project, owner: null, notes_total: 206 });
      expect(brief.members.map((member: { agent_id: string; kind: string; live: boolean; process_liveness: string }) =>
        [member.agent_id, member.kind, member.live, member.process_liveness]).sort())
        .toEqual([["claude:brief", "agent", true, "unknown"], ["codex:brief", "agent", true, "unknown"], ["grok:silent", "agent", false, "unknown"]]);
      // The latest handoff is whole; the listing only excerpts it.
      expect(brief.last_handoff.handoff).toMatchObject({ status: fullStatus, next_action: "Review the parser." });
      expect(brief.notes.map((note: { body: string }) => note.body))
        .toEqual(Array.from({ length: 10 }, (_, index) => `note ${195 + index}`));
      expect(brief.recent.map((event: { event_type: string; body?: string }) => event.body?.slice(0, 8) ?? event.event_type))
        .toEqual(["long yyy", "release", "update 1", "update 2", "update 3"]);
      expect(brief.recent[0]).toMatchObject({ truncated: true, to: "codex:brief" });
      expect(brief.recent[0].body).toHaveLength(1000);
      // Clipped bodies and handoffs stay readable in full.
      expect(JSON.parse(await run(brief.recent[0].full)).events[0].payload.body).toBe(`long ${"y".repeat(1500)}`);
      expect(brief.recent[1].status).toHaveLength(160);
      expect(JSON.parse(await run(brief.recent[1].full)).events[0].handoff.status).toBe(fullStatus);
      expect(brief.recent[2].full).toBeUndefined();
      expect(brief.older).toBeNull();
      expect(brief.cursor_event_seq).toBe(before.cursor_event_seq);
      expect(brief.updates_since).toBe(`tt events --in ${before.room.room_id} --after ${before.cursor_event_seq} --target any --json`);
      // Paging back with --before neither skips nor repeats an event.
      const pages: number[][] = [];
      let page = JSON.parse(await captureStdout(["room", "brief", "project", "--limit", "2", "--json"]));
      for (;;) {
        pages.unshift(page.recent.map((event: { event_seq: number }) => event.event_seq));
        if (!page.older) break;
        page = JSON.parse(await run(page.older));
      }
      expect(pages.map((seqs) => seqs.length)).toEqual([1, 2, 2]);
      expect(pages.flat()).toEqual(brief.recent.map((event: { event_seq: number }) => event.event_seq));
      const text = await captureStdout(["room", "brief", project, "--text"]);
      expect(text).toContain("stick: nobody, reserved for codex:brief");
      expect(text).toContain("members: claude:brief, codex:brief, grok:silent (inactive)");
      expect(text).toContain("open notes (newest 10 of 206):");
      await expect(captureStdout(["room", "brief", "nope", "--json"])).rejects.toThrow(/No open room matches nope/);
    } finally {
      process.chdir(cwd);
    }

    // Reading joined nobody and refreshed nobody.
    const after = JSON.parse(await captureStdout(["state", project, "--agent", "human:observer", "--json"]));
    expect(after.members.map((member: { agent_id: string; last_seen_at: string }) => [member.agent_id, member.last_seen_at]))
      .toEqual(before.members.map((member: { agent_id: string; last_seen_at: string }) => [member.agent_id, member.last_seen_at]));
    for (const dir of registry) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("ask, reply, and replies carry a visitor's question without moving anyone", async () => {
    const registry: string[] = [];
    const { project } = setupIsolatedCli(registry);
    const home = path.join(path.dirname(project), "home");
    fs.mkdirSync(home);
    process.env.TT_HARNESS_AGENT_ID = "grok:stay";
    await captureStdout(["join", project, "--json"]);
    process.env.TT_HARNESS_AGENT_ID = "codex:answer";
    const target = JSON.parse(await captureStdout(["join", project, "--json"]));
    // The visitor is an agent busy in its own room; asking must not move it.
    process.env.TT_HARNESS_AGENT_ID = "claude:visitor";
    const own = JSON.parse(await captureStdout(["join", home, "--json"]));
    const before = JSON.parse(await captureStdout(["state", project, "--agent", "human:observer", "--json"])).members;

    const asked = JSON.parse(await captureStdout(["room", "ask", "project", "--to", "codex", "What", "changed?", "--json"]));
    expect(asked).toMatchObject({ room_id: target.room_id, recipients: ["codex:answer"], deduplicated: false,
      replies: `tt room replies ${asked.request_id} --timeout 30` });
    expect(JSON.parse(await captureStdout(["state", project, "--agent", "human:observer", "--json"])).members).toEqual(before);
    expect(JSON.parse(await captureStdout(["state", home, "--agent", "human:observer", "--json"])).members
      .map((member: { agent_id: string }) => member.agent_id)).toEqual(["claude:visitor"]);
    await expect(captureStdout(["room", "ask", "project", "--to", "nobody", "hi", "--json"])).rejects.toThrow(/No agent named nobody/);

    const started = Date.now();
    const empty = JSON.parse(await captureStdout(["room", "replies", asked.request_id, "--timeout", "1", "--json"]));
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(empty).toMatchObject({ replies: [], timed_out: true, cursor_event_seq: asked.event_seq });
    await expect(captureStdout(["room", "replies", asked.request_id, "--timeout", "61", "--json"])).rejects.toThrow(/at most 60/);
    // The visitor is not a member of the asked room, so it cannot answer there.
    await expect(captureStdout(["msg", "reply", asked.request_id, "me", "--json"])).rejects.toThrow(/must join the room/);

    process.env.TT_HARNESS_AGENT_ID = "codex:answer";
    const replied = JSON.parse(await captureStdout(["msg", "reply", asked.request_id, "The", "parser.", "--json"]));
    expect(replied).toMatchObject({ request_id: asked.request_id, room_id: target.room_id });
    process.env.TT_HARNESS_AGENT_ID = "claude:visitor";
    const answers = JSON.parse(await captureStdout(["room", "replies", asked.request_id, "--timeout", "5", "--json"]));
    expect(answers).toMatchObject({ timed_out: false, cursor_event_seq: replied.event_seq, has_more: false });
    expect(answers.replies.map((reply: { from_agent_id: string; payload: { body: string } }) => [reply.from_agent_id, reply.payload.body]))
      .toEqual([["codex:answer", "The parser."]]);
    const repliesText = await captureStdout(["room", "replies", asked.request_id, "--text"]);
    expect(repliesText).toContain("codex:answer:\n  The parser.");
    expect(repliesText).toMatch(/Recipients:\n  codex:answer: delivery \S+; (?:received \S+|no receipt on record); replied/);
    expect(answers.recipient_status).toEqual([expect.objectContaining({ agent_id: "codex:answer", in_room: true, replied: true })]);
    // The brief tells a correlated answer (to null) apart from a room broadcast.
    process.env.TT_HARNESS_AGENT_ID = "codex:answer";
    await captureStdout(["msg", "send", "room", "Just a broadcast.", "--path", project, "--json"]);
    process.env.TT_HARNESS_AGENT_ID = "claude:visitor";
    const brief = JSON.parse(await captureStdout(["room", "brief", "project", "--json"]));
    const bySeq = (seq: number) => brief.recent.find((event: { event_seq: number }) => event.event_seq === seq);
    expect(bySeq(asked.event_seq)).toMatchObject({ request_id: asked.request_id, from_agent_id: "claude:visitor" });
    expect(bySeq(replied.event_seq)).toMatchObject({ in_reply_to: asked.request_id, to: null });
    const broadcast = brief.recent.at(-1);
    expect(broadcast).toMatchObject({ body: "Just a broadcast.", to: null });
    expect(broadcast.in_reply_to).toBeUndefined();
    expect(broadcast.request_id).toBeUndefined();
    const briefText = await captureStdout(["room", "brief", "project", "--text"]);
    expect(briefText).toContain(`visitor claude:visitor → codex:answer (request ${asked.request_id})`);
    expect(briefText).toContain(`codex:answer → visitor (reply to request ${asked.request_id})`);
    expect(briefText).toMatch(/codex:answer → room\n    Just a broadcast\./);
    expect(JSON.parse(await captureStdout(["state", home, "--agent", "human:observer", "--json"])).room.room_id).toBe(own.room_id);
    await expect(captureStdout(["room", "replies", "zzzzzzzz", "--json"])).rejects.toThrow(/No such request/);

    // A keyed retry returns the original even after the named agent left.
    const keyed = JSON.parse(await captureStdout(["room", "ask", "project", "--to", "codex:answer", "--request-key", "k", "Still", "there?", "--json"]));
    process.env.TT_HARNESS_AGENT_ID = "codex:answer";
    await captureStdout(["leave", project, "--json"]);
    process.env.TT_HARNESS_AGENT_ID = "claude:visitor";
    const cursor = JSON.parse(await captureStdout(["state", project, "--agent", "human:observer", "--json"])).cursor_event_seq;
    const retried = JSON.parse(await captureStdout(["room", "ask", "project", "--to", "codex:answer,codex:answer", "--request-key", "k", "Still", "there?", "--json"]));
    expect(retried).toMatchObject({ request_id: keyed.request_id, event_seq: keyed.event_seq, recipients: ["codex:answer"], deduplicated: true });
    expect(JSON.parse(await captureStdout(["state", project, "--agent", "human:observer", "--json"])).cursor_event_seq).toBe(cursor);
    await expect(captureStdout(["room", "ask", "project", "--to", "codex:answer", "--request-key", "k", "Other?", "--json"]))
      .rejects.toThrow(/request_key was already used/);
    await expect(captureStdout(["room", "ask", "project", "--to", "codex:answer", "Other?", "--json"])).rejects.toThrow(/No agent named codex:answer/);
    for (const dir of registry) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a signal ends a replies wait as interrupted, not timed out", async () => {
    const registry: string[] = [];
    const { project } = setupIsolatedCli(registry);
    process.env.TT_HARNESS_AGENT_ID = "codex:answer";
    await captureStdout(["join", project, "--json"]);
    process.env.TT_HARNESS_AGENT_ID = "claude:visitor";
    const asked = JSON.parse(await captureStdout(["room", "ask", project, "--to", "codex", "status?", "--json"]));
    const waiter = spawnCliProcess(["room", "replies", asked.request_id, "--timeout", "30", "--json"]);
    // Long enough for the CLI to start and install its handler.
    await delay(3_000);
    const started = Date.now();
    const closed = waitForProcessClose(waiter.child);
    waiter.child.kill("SIGINT");
    expect(await closed).toMatchObject({ code: 130, signal: null });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(JSON.parse(waiter.stdout())).toMatchObject({ replies: [], interrupted: true, timed_out: false, cursor_event_seq: asked.event_seq });
    for (const dir of registry) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("adopt declares a legacy nested room without changing its id", async () => {
    const registry: string[] = [];
    const { project } = setupIsolatedCli(registry);
    execFileSync("git", ["init", "-q", "-b", "main", project]);
    const tools = path.join(project, "tools");
    fs.mkdirSync(tools, { recursive: true });
    process.env.TT_HARNESS_AGENT_ID = "claude:adopt";
    const legacy = JSON.parse(await captureStdout(["join", tools, "--force-new", "--json"]));
    expect(legacy.warning).toContain("--force-new is deprecated");
    const before = JSON.parse(await captureStdout(["room", "list", project, "--json"]));
    expect(before.rooms.find((room: { room_id: string }) => room.room_id === legacy.room_id).kind).toBe("legacy");

    const adopted = JSON.parse(await captureStdout(["room", "adopt", tools, "--json"]));
    expect(adopted).toMatchObject({ status: "adopted", room_id: legacy.room_id, canonical_path: tools });
    expect(JSON.parse(await captureStdout(["join", tools, "--json"])).room_id).toBe(legacy.room_id);
    await expect(captureStdout(["room", "adopt", tools, "--json"])).rejects.toThrow(/already declared/);
    for (const dir of registry) fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("tt roles", () => {
  test("instructions show the live role block, drop only bundled role lines, and keep user text", async () => {
    const registry: string[] = [];
    const { dataDir, project } = setupIsolatedCli(registry);
    fs.writeFileSync(path.join(dataDir, "instructions.md"), "# Local\n\nDefault role: my own house rule\n");
    process.env.TT_HARNESS_AGENT_ID = "claude:roles";
    await captureStdout(["join", project, "--json"]);
    process.env.TT_HARNESS_AGENT_ID = "codex:roles";
    await captureStdout(["join", project, "--json"]);

    process.env.TT_HARNESS_AGENT_ID = "claude:roles";
    const shown = JSON.parse(await captureStdout(["instructions", "show", project, "--harness", "claude", "--json"]));
    expect(shown.text).toContain("## Roles");
    expect(shown.text).toContain("- You (claude:roles): architect");
    expect(shown.text).toContain("- codex:roles: implementer");
    expect(shown.text).toContain("Default role: my own house rule");
    expect(shown.text).not.toContain("Default role: architecture, drafting");

    // Agents can read roles but cannot assign them.
    await expect(captureStdout(["roles", "set", "codex", "reviewer", "--path", project, "--json"])).rejects.toThrow(/operator/);
    delete process.env.TT_HARNESS_AGENT_ID;
    const applied = JSON.parse(await captureStdout(["roles", "set", "codex:roles", "reviewer,tester", "--in", "root", "--path", project, "--json"]));
    expect(applied).toMatchObject({ status: "applied", version: 1, recipients: ["codex:roles"] });
    process.env.TT_HARNESS_AGENT_ID = "codex:roles";
    const forCodex = JSON.parse(await captureStdout(["instructions", "show", project, "--harness", "codex", "--json"]));
    expect(forCodex.text).toContain("- You (codex:roles): reviewer (independent review and cross-checks); tester");

    delete process.env.TT_HARNESS_AGENT_ID;
    const cleared = JSON.parse(await captureStdout(["roles", "default", "grok", "clear", "--json"]));
    expect(cleared).toMatchObject({ status: "cleared", roles: ["implementer", "reviewer"] });
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, "roles.json"), "utf8"))).toEqual({});
    for (const dir of registry) fs.rmSync(dir, { recursive: true, force: true });
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

async function waitForActiveListener(
  project: string,
  agentId: string,
  listener: SpawnedCliProcess,
  timeoutMs = 5_000
): Promise<{
  listener: { status: string; active: boolean; duplicates: number };
}> {
  type ListenerHealth = {
    listener: { status: string; active: boolean; duplicates: number };
  };
  const deadline = Date.now() + timeoutMs;
  let lastHealth: ListenerHealth | undefined;

  while (Date.now() < deadline) {
    if (listener.child.exitCode !== null) {
      throw new Error(
        `Listener exited before registration: code=${listener.child.exitCode} stderr=${listener.stderr()}`
      );
    }
    const health = JSON.parse(await captureStdout([
      "health", project, "--agent", agentId, "--json"
    ])) as ListenerHealth;
    lastHealth = health;
    if (health.listener.active) {
      return health;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(
    `Listener did not become active within ${timeoutMs}ms: ${JSON.stringify(lastHealth)}`
  );
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
