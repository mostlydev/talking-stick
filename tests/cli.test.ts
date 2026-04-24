import { afterEach, describe, expect, test, vi } from "vitest";
import { checkGuardianLiveness, runCli } from "../src/cli.js";

const ENV_KEYS = [
  "TT_HARNESS_EXPORT",
  "TT_HARNESS_AGENT_ID",
  "CLAUDECODE",
  "CLAUDE_CODE_EXECPATH"
] as const;

const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]])
);

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

  test("derives harness identity only when export is explicitly enabled", async () => {
    process.env.TT_HARNESS_EXPORT = "1";
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_EXECPATH = "/opt/claude/2.1.118";
    delete process.env.TT_HARNESS_AGENT_ID;

    const stdout = await captureStdout(["whoami", "--json"]);
    const result = JSON.parse(stdout) as {
      agent_id: string;
      source: string;
      process_metadata: { session_kind: string };
    };

    expect(result.agent_id).toMatch(/^claude:/);
    expect(result.source).toBe("harness_cli_exported_detection");
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

async function captureStdout(argv: string[]): Promise<string> {
  let stdout = "";
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
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }

  return stdout;
}
