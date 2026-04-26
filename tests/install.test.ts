import { describe, expect, test } from "vitest";
import {
  detectHarness,
  parseHarnessList,
  resolveHarnessConfigDir,
  planInstall,
  planUninstall,
  resolveOpencodeConfigPath,
  runAction,
  SUPPORTED_HARNESSES,
  type HarnessId,
  type InstallOptions
} from "../src/install.js";

describe("planInstall", () => {
  test.each([
    ["claude-code", "claude mcp add -s user talking-stick -- tt mcp"],
    ["codex", "codex mcp add talking-stick -- tt mcp"],
    ["gemini", "gemini mcp add -s user -t stdio talking-stick tt mcp"]
  ] satisfies Array<[HarnessId, string]>)("produces expected exec command for %s", (harness, expected) => {
    const action = planInstall(harness);
    expect(action.kind).toBe("exec");
    expect(action.description).toBe(expected);
  });

  test("produces a file-patch action for opencode with merged config", () => {
    const memory = memoryFs();
    const action = planInstall("opencode", {
      env: { HOME: "/tmp/home" },
      platform: "linux",
      homeDir: "/tmp/home",
      ...memory.hooks
    });
    expect(action.kind).toBe("file-patch");
    if (action.kind !== "file-patch") throw new Error("unreachable");

    action.apply();
    const written = memory.files.get("/tmp/home/.config/opencode/opencode.json");
    expect(written).toBeDefined();
    const config = JSON.parse(written!) as { mcp: Record<string, unknown> };
    expect(config.mcp["talking-stick"]).toEqual({
      type: "local",
      command: ["tt", "mcp"],
      enabled: true
    });
  });

  test("opencode install preserves existing mcp entries and other config keys", () => {
    const memory = memoryFs({
      "/home/u/.config/opencode/opencode.json": JSON.stringify({
        theme: "opendark",
        mcp: {
          other: { type: "local", command: ["other", "run"], enabled: true }
        }
      })
    });
    const action = planInstall("opencode", {
      env: {},
      platform: "linux",
      homeDir: "/home/u",
      ...memory.hooks
    });
    if (action.kind !== "file-patch") throw new Error("unreachable");
    action.apply();

    const config = JSON.parse(memory.files.get("/home/u/.config/opencode/opencode.json")!);
    expect(config.theme).toBe("opendark");
    expect(config.mcp.other).toEqual({ type: "local", command: ["other", "run"], enabled: true });
    expect(config.mcp["talking-stick"]).toEqual({
      type: "local",
      command: ["tt", "mcp"],
      enabled: true
    });
  });

  test("honors XDG_CONFIG_HOME for opencode", () => {
    const configPath = resolveOpencodeConfigPath({
      env: { XDG_CONFIG_HOME: "/custom/config" },
      platform: "linux",
      homeDir: "/home/u"
    });
    expect(configPath).toBe("/custom/config/opencode/opencode.json");
  });

  test("resolves expected harness config directories", () => {
    expect(resolveHarnessConfigDir("claude-code", { homeDir: "/home/u" })).toBe("/home/u/.claude");
    expect(resolveHarnessConfigDir("codex", { homeDir: "/home/u" })).toBe("/home/u/.codex");
    expect(resolveHarnessConfigDir("gemini", { homeDir: "/home/u" })).toBe("/home/u/.gemini");
    expect(resolveHarnessConfigDir("opencode", { env: {}, homeDir: "/home/u" })).toBe(
      "/home/u/.config/opencode"
    );
  });

  test("serverName and serverCommand overrides are respected", () => {
    const action = planInstall("claude-code", {
      serverName: "ts-alpha",
      serverCommand: ["node", "/abs/path/cli.js", "mcp"]
    });
    if (action.kind !== "exec") throw new Error("unreachable");
    expect(action.args).toEqual([
      "mcp",
      "add",
      "-s",
      "user",
      "ts-alpha",
      "--",
      "node",
      "/abs/path/cli.js",
      "mcp"
    ]);
  });
});

describe("planUninstall", () => {
  test("removes the server entry from opencode config", () => {
    const memory = memoryFs({
      "/home/u/.config/opencode/opencode.json": JSON.stringify({
        mcp: {
          "talking-stick": { type: "local", command: ["tt", "mcp"], enabled: true },
          keep: { type: "local", command: ["keep"], enabled: true }
        }
      })
    });
    const action = planUninstall("opencode", {
      env: {},
      platform: "linux",
      homeDir: "/home/u",
      ...memory.hooks
    });
    if (action.kind !== "file-patch") throw new Error("unreachable");
    action.apply();

    const config = JSON.parse(memory.files.get("/home/u/.config/opencode/opencode.json")!);
    expect(config.mcp["talking-stick"]).toBeUndefined();
    expect(config.mcp.keep).toBeDefined();
  });

  test("produces claude mcp remove with user scope", () => {
    const action = planUninstall("claude-code");
    expect(action.description).toBe("claude mcp remove -s user talking-stick");
  });
});

describe("detectHarness", () => {
  test("returns detected=true when binary is on PATH", () => {
    const result = detectHarness("claude-code", {
      ...memoryFs().hooks,
      which: (binary) => (binary === "claude" ? "/usr/local/bin/claude" : null)
    });
    expect(result.detected).toBe(true);
    expect(result.evidence).toBe("/usr/local/bin/claude");
  });

  test("opencode falls back to existing config file when binary missing", () => {
    const memory = memoryFs({
      "/home/u/.config/opencode/opencode.json": "{}"
    });
    const result = detectHarness("opencode", {
      env: {},
      platform: "linux",
      homeDir: "/home/u",
      ...memory.hooks,
      which: () => null
    });
    expect(result.detected).toBe(true);
    expect(result.evidence).toBe("/home/u/.config/opencode/opencode.json");
  });

  test("falls back to existing config directory when binary missing", () => {
    const memory = memoryFs({}, ["/home/u/.codex"]);
    const result = detectHarness("codex", {
      env: {},
      platform: "linux",
      homeDir: "/home/u",
      ...memory.hooks,
      which: () => null
    });
    expect(result.detected).toBe(true);
    expect(result.evidence).toBe("/home/u/.codex");
  });

  test("returns detected=false when nothing points at the harness", () => {
    const result = detectHarness("codex", {
      ...memoryFs().hooks,
      which: () => null
    });
    expect(result.detected).toBe(false);
  });
});

describe("parseHarnessList", () => {
  test("rejects unknown harnesses with a helpful message", () => {
    expect(() => parseHarnessList(["claude-code", "rogue"])).toThrow(/Unknown harness: rogue/);
  });

  test("dedupes while preserving order", () => {
    expect(parseHarnessList(["codex", "gemini", "codex"])).toEqual(["codex", "gemini"]);
  });
});

describe("runAction", () => {
  test("forwards exit code 0 as ok=true and captures stdout", async () => {
    const action = planInstall("claude-code");
    const result = await runAction(action, {
      which: () => "/usr/local/bin/claude",
      run: async () => ({ exitCode: 0, stdout: "Added talking-stick", stderr: "" })
    });
    expect(result.ok).toBe(true);
    expect(result.message).toBe("Added talking-stick");
  });

  test("marks ok=false on non-zero exit and prefers stderr", async () => {
    const action = planInstall("claude-code");
    const result = await runAction(action, {
      which: () => "/usr/local/bin/claude",
      run: async () => ({ exitCode: 2, stdout: "", stderr: "claude: command not found" })
    });
    expect(result.ok).toBe(false);
    expect(result.message).toBe("claude: command not found");
  });

  test("fails cleanly before spawn when the executable is not on PATH", async () => {
    const action = planInstall("codex");
    let invoked = false;
    const result = await runAction(action, {
      which: () => null,
      run: async () => {
        invoked = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    });

    expect(invoked).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.message).toBe("codex not on PATH");
  });

  test("skips missing exec harnesses when requested", async () => {
    const action = planInstall("codex");
    let invoked = false;
    const result = await runAction(action, {
      skipMissing: true,
      which: () => null,
      run: async () => {
        invoked = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    });

    expect(invoked).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.message).toBe("codex not on PATH");
  });

  test("skips opencode install when its config directory is missing", async () => {
    const memory = memoryFs();
    const action = planInstall("opencode", {
      env: {},
      platform: "linux",
      homeDir: "/home/u",
      skipMissing: true,
      ...memory.hooks
    });

    const result = await runAction(action, {
      skipMissing: true,
      ...memory.hooks
    });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(memory.files.has("/home/u/.config/opencode/opencode.json")).toBe(false);
  });

  test("installs opencode config when skipMissing is set and config directory exists", async () => {
    const memory = memoryFs({}, ["/home/u/.config/opencode"]);
    const action = planInstall("opencode", {
      env: {},
      platform: "linux",
      homeDir: "/home/u",
      skipMissing: true,
      ...memory.hooks
    });

    const result = await runAction(action, {
      skipMissing: true,
      ...memory.hooks
    });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(memory.files.has("/home/u/.config/opencode/opencode.json")).toBe(true);
  });

  test("uses the resolved executable path for direct binaries", async () => {
    const action = planInstall("codex");
    let command = "";
    let args: string[] = [];
    let windowsHide: boolean | undefined;

    const result = await runAction(action, {
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      which: (binary) => (binary === "codex" ? "C:\\Tools\\codex.exe" : null),
      run: async (resolvedCommand, resolvedArgs, options) => {
        command = resolvedCommand;
        args = resolvedArgs;
        windowsHide = options?.windowsHide;
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }
    });

    expect(result.ok).toBe(true);
    expect(command).toBe("C:\\Tools\\codex.exe");
    expect(args).toEqual(["mcp", "add", "talking-stick", "--", "tt", "mcp"]);
    expect(windowsHide).toBe(true);
  });

  test("uses cmd.exe to launch .cmd wrappers on Windows", async () => {
    const action = planInstall("codex");
    let command = "";
    let args: string[] = [];
    let windowsHide: boolean | undefined;

    const result = await runAction(action, {
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      which: (binary) => (binary === "codex" ? "C:\\Tools\\codex.cmd" : null),
      run: async (resolvedCommand, resolvedArgs, options) => {
        command = resolvedCommand;
        args = resolvedArgs;
        windowsHide = options?.windowsHide;
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }
    });

    expect(result.ok).toBe(true);
    expect(command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(args).toEqual([
      "/d",
      "/s",
      "/c",
      "C:\\Tools\\codex.cmd",
      "mcp",
      "add",
      "talking-stick",
      "--",
      "tt",
      "mcp"
    ]);
    expect(windowsHide).toBe(true);
  });

  test("rejects cmd.exe wrapper args with Windows command metacharacters", async () => {
    const action = planInstall("codex", { serverName: "talking&stick" });
    let invoked = false;

    const result = await runAction(action, {
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      which: (binary) => (binary === "codex" ? "C:\\Tools\\codex.cmd" : null),
      run: async () => {
        invoked = true;
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }
    });

    expect(invoked).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.message).toBe(
      "Cannot safely launch codex through cmd.exe because " +
        "an argument contains Windows command metacharacters (& | < > ^ % \")."
    );
  });

  test("converts thrown spawn errors into a normal install failure", async () => {
    const action = planInstall("claude-code");
    const result = await runAction(action, {
      which: () => "/usr/local/bin/claude",
      run: async () => {
        throw new Error("spawn /usr/local/bin/claude EACCES");
      }
    });

    expect(result.ok).toBe(false);
    expect(result.message).toBe("spawn /usr/local/bin/claude EACCES");
  });
});

test("SUPPORTED_HARNESSES is the full expected set", () => {
  expect([...SUPPORTED_HARNESSES].sort()).toEqual(["claude-code", "codex", "gemini", "opencode"].sort());
});

interface MemoryFs {
  files: Map<string, string>;
  dirs: Set<string>;
  hooks: Pick<InstallOptions, "readFile" | "writeFile" | "ensureDir" | "pathExists" | "which">;
}

function memoryFs(seed: Record<string, string> = {}, dirs: string[] = []): MemoryFs {
  const files = new Map<string, string>(Object.entries(seed));
  const dirSet = new Set(dirs);
  return {
    files,
    dirs: dirSet,
    hooks: {
      readFile: (filePath) => files.get(filePath) ?? null,
      writeFile: (filePath, data) => {
        files.set(filePath, data);
      },
      ensureDir: (dirPath) => {
        dirSet.add(dirPath);
      },
      pathExists: (filePath) => files.has(filePath) || dirSet.has(filePath),
      which: () => null
    }
  };
}
