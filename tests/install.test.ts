import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  buildGrokSessionHookConfig,
  detectHarness,
  parseHarnessList,
  planGrokSessionHookInstall,
  planGrokSessionHookUninstall,
  resolveHarnessConfigDir,
  planUninstall,
  resolveGrokSessionHookPath,
  resolveOpencodeConfigPath,
  runAction,
  SUPPORTED_HARNESSES,
  type HarnessId,
  type InstallOptions
} from "../src/install.js";

describe("planUninstall", () => {
  test.each([
    ["claude-code", "claude mcp remove -s user talking-stick"],
    ["codex", "codex mcp remove talking-stick"],
    ["gemini", "gemini mcp remove -s user talking-stick"]
  ] satisfies Array<[HarnessId, string]>)("plans stale MCP removal for %s", (harness, expected) => {
    const action = planUninstall(harness);
    expect(action.kind).toBe("exec");
    expect(action.description).toBe(expected);
  });

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

  test("preserves existing opencode config keys while removing MCP", () => {
    const memory = memoryFs({
      "/home/u/.config/opencode/opencode.json": JSON.stringify({
        theme: "opendark",
        mcp: {
          "talking-stick": { type: "local", command: ["tt", "mcp"], enabled: true },
          other: { type: "local", command: ["other", "run"], enabled: true }
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
    expect(config.theme).toBe("opendark");
    expect(config.mcp.other).toEqual({ type: "local", command: ["other", "run"], enabled: true });
    expect(config.mcp["talking-stick"]).toBeUndefined();
  });

  test("rewrites opencode config with an atomic rename", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tt-install-"));
    const configPath = path.join(tempRoot, ".config", "opencode", "opencode.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcp: {
          "talking-stick": { type: "local", command: ["tt", "mcp"], enabled: true }
        }
      })
    );
    const renameSpy = vi.spyOn(fs, "renameSync");

    try {
      const action = planUninstall("opencode", {
        env: {},
        platform: "linux",
        homeDir: tempRoot
      });
      if (action.kind !== "file-patch") throw new Error("unreachable");
      action.apply();

      expect(renameSpy).toHaveBeenCalledWith(
        expect.stringContaining(".opencode.json."),
        configPath
      );
    } finally {
      renameSpy.mockRestore();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
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
    expect(resolveHarnessConfigDir("grok", { env: {}, homeDir: "/home/u" })).toBe("/home/u/.grok");
    expect(resolveHarnessConfigDir("opencode", { env: {}, homeDir: "/home/u" })).toBe(
      "/home/u/.config/opencode"
    );
  });

  test("honors GROK_HOME for Grok config and hook paths", () => {
    const options = {
      env: { GROK_HOME: "/custom/grok" },
      homeDir: "/home/u"
    };

    expect(resolveHarnessConfigDir("grok", options)).toBe("/custom/grok");
    expect(resolveGrokSessionHookPath(options)).toBe(
      "/custom/grok/hooks/talking-stick-session.json"
    );
  });

  test("plans no stale MCP cleanup for Grok", () => {
    const action = planUninstall("grok");

    expect(action.kind).toBe("skip");
    if (action.kind !== "skip") {
      throw new Error("unreachable");
    }
    expect(action.message).toBe("legacy Talking Stick cleanup is not applicable for grok");
  });
});

describe("Grok hook install", () => {
  test("writes the global Grok session hook manifest", () => {
    const memory = memoryFs({}, ["/home/u/.grok"]);
    const action = planGrokSessionHookInstall({
      env: {},
      homeDir: "/home/u",
      skipMissing: true,
      ...memory.hooks
    });

    expect(action.kind).toBe("file-patch");
    if (action.kind !== "file-patch") {
      throw new Error("unreachable");
    }
    action.apply();

    const hookPath = "/home/u/.grok/hooks/talking-stick-session.json";
    expect(memory.files.get(hookPath)).toBe(buildGrokSessionHookConfig());
    expect(memory.dirs.has("/home/u/.grok/hooks")).toBe(true);
  });

  test("skips hook install when the Grok config root is missing", () => {
    const memory = memoryFs();
    const action = planGrokSessionHookInstall({
      env: {},
      homeDir: "/home/u",
      skipMissing: true,
      ...memory.hooks
    });

    expect(action.kind).toBe("skip");
  });

  test("removes the global Grok session hook manifest", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-hook-"));
    const hookPath = path.join(tempRoot, ".grok", "hooks", "talking-stick-session.json");
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, buildGrokSessionHookConfig());

    const action = planGrokSessionHookUninstall({
      env: {},
      homeDir: tempRoot
    });
    expect(action.kind).toBe("file-patch");
    if (action.kind !== "file-patch") {
      throw new Error("unreachable");
    }
    action.apply();

    expect(fs.existsSync(hookPath)).toBe(false);
    fs.rmSync(tempRoot, { recursive: true, force: true });
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
  test("skips native remove when a Claude MCP server is already absent", async () => {
    const action = planUninstall("claude-code");
    const calls: string[][] = [];
    const result = await runAction(action, {
      which: () => "/usr/local/bin/claude",
      run: async (_command, args) => {
        calls.push(args);
        return { exitCode: 1, stdout: "", stderr: "not found" };
      }
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("already_absent");
    expect(result.message).toBe(
      "MCP server 'talking-stick' is not registered in Claude Code user config."
    );
    expect(calls).toEqual([["mcp", "get", "talking-stick"]]);
  });

  test("runs native remove and reports removed when preflight finds the server", async () => {
    const action = planUninstall("claude-code");
    const calls: string[][] = [];
    const result = await runAction(action, {
      which: () => "/usr/local/bin/claude",
      run: async (_command, args) => {
        calls.push(args);
        if (args[1] === "get") {
          return { exitCode: 0, stdout: "talking-stick: tt mcp", stderr: "" };
        }
        return { exitCode: 0, stdout: "Removed talking-stick", stderr: "" };
      }
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("removed");
    expect(result.message).toBe(
      "MCP server 'talking-stick' removed from Claude Code user config."
    );
    expect(calls).toEqual([
      ["mcp", "get", "talking-stick"],
      ["mcp", "remove", "-s", "user", "talking-stick"]
    ]);
  });

  test("marks ok=false on non-zero remove and prefers stderr", async () => {
    const action = planUninstall("claude-code");
    const result = await runAction(action, {
      which: () => "/usr/local/bin/claude",
      run: async (_command, args) => {
        if (args[1] === "get") {
          return { exitCode: 0, stdout: "talking-stick: tt mcp", stderr: "" };
        }
        return { exitCode: 2, stdout: "", stderr: "claude: remove failed" };
      }
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.message).toBe("claude: remove failed");
  });

  test("treats native already-absent errors as already absent", async () => {
    const action = planUninstall("claude-code");
    const result = await runAction(action, {
      which: () => "/usr/local/bin/claude",
      run: async (_command, args) => {
        if (args[1] === "get") {
          return { exitCode: 0, stdout: "talking-stick: tt mcp", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "MCP server talking-stick not found" };
      }
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("already_absent");
    expect(result.message).toBe(
      "MCP server 'talking-stick' is not registered in Claude Code user config."
    );
  });

  test("fails cleanly before spawn when the executable is not on PATH", async () => {
    const action = planUninstall("codex");
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
    expect(result.status).toBe("failed");
    expect(result.message).toBe("codex not on PATH");
  });

  test("skips missing exec harnesses when requested", async () => {
    const action = planUninstall("codex");
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
    expect(result.status).toBe("skipped");
    expect(result.skipped).toBe(true);
    expect(result.message).toBe("codex not on PATH");
  });

  test("skips opencode removal when its config directory is missing", async () => {
    const memory = memoryFs();
    const action = planUninstall("opencode", {
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
    expect(result.status).toBe("skipped");
    expect(result.skipped).toBe(true);
    expect(memory.files.has("/home/u/.config/opencode/opencode.json")).toBe(false);
  });

  test("skips opencode removal when the MCP config is already absent", async () => {
    const memory = memoryFs({
      "/home/u/.config/opencode/opencode.json": JSON.stringify({
        mcp: {
          keep: {
            type: "local",
            command: ["keep"],
            enabled: true
          }
        }
      })
    }, ["/home/u/.config/opencode"]);
    const action = planUninstall("opencode", {
      env: {},
      platform: "linux",
      homeDir: "/home/u",
      skipMissing: true,
      ...memory.hooks
    });

    const before = memory.files.get("/home/u/.config/opencode/opencode.json");
    const result = await runAction(action, {
      skipMissing: true,
      ...memory.hooks
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("already_absent");
    expect(memory.files.get("/home/u/.config/opencode/opencode.json")).toBe(before);
  });

  test("skips gemini remove when settings do not contain the MCP server", async () => {
    const memory = memoryFs({
      "/home/u/.gemini/settings.json": JSON.stringify({
        mcpServers: {
          other: {
            command: "other",
            args: ["mcp"]
          }
        }
      })
    });
    const action = planUninstall("gemini", {
      env: {},
      platform: "linux",
      homeDir: "/home/u",
      ...memory.hooks
    });
    let invoked = false;

    const result = await runAction(action, {
      env: {},
      platform: "linux",
      homeDir: "/home/u",
      ...memory.hooks,
      which: (binary) => (binary === "gemini" ? "/usr/local/bin/gemini" : null),
      run: async () => {
        invoked = true;
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }
    });

    expect(invoked).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("already_absent");
    expect(result.message).toBe(
      "MCP server 'talking-stick' is not registered in Gemini user config."
    );
  });

  test("uses the resolved executable path for direct binaries", async () => {
    const action = planUninstall("codex");
    const calls: Array<{
      command: string;
      args: string[];
      windowsHide: boolean | undefined;
    }> = [];

    const result = await runAction(action, {
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      which: (binary) => (binary === "codex" ? "C:\\Tools\\codex.exe" : null),
      run: async (resolvedCommand, resolvedArgs, options) => {
        calls.push({
          command: resolvedCommand,
          args: resolvedArgs,
          windowsHide: options?.windowsHide
        });
        if (resolvedArgs[1] === "get") {
          return { exitCode: 0, stdout: "talking-stick: tt mcp", stderr: "" };
        }
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }
    });

    expect(result.ok).toBe(true);
    expect(calls.at(-1)).toEqual({
      command: "C:\\Tools\\codex.exe",
      args: ["mcp", "remove", "talking-stick"],
      windowsHide: true
    });
  });

  test("uses cmd.exe to launch .cmd wrappers on Windows", async () => {
    const action = planUninstall("codex");
    const calls: Array<{
      command: string;
      args: string[];
      windowsHide: boolean | undefined;
    }> = [];

    const result = await runAction(action, {
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      which: (binary) => (binary === "codex" ? "C:\\Tools\\codex.cmd" : null),
      run: async (resolvedCommand, resolvedArgs, options) => {
        calls.push({
          command: resolvedCommand,
          args: resolvedArgs,
          windowsHide: options?.windowsHide
        });
        if (resolvedArgs.at(-1) === "talking-stick" && resolvedArgs.at(-3) === "get") {
          return { exitCode: 0, stdout: "talking-stick: tt mcp", stderr: "" };
        }
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }
    });

    expect(result.ok).toBe(true);
    expect(calls.at(-1)).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        "C:\\Tools\\codex.cmd",
        "mcp",
        "remove",
        "talking-stick"
      ],
      windowsHide: true
    });
  });

  test("rejects cmd.exe wrapper args with Windows command metacharacters", async () => {
    const action = planUninstall("codex", { serverName: "talking&stick" });
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
    expect(result.status).toBe("failed");
    expect(result.message).toBe(
      "Cannot safely launch codex through cmd.exe because " +
        "an argument contains Windows command metacharacters (& | < > ^ % \")."
    );
  });

  test("converts thrown spawn errors into a normal uninstall failure", async () => {
    const action = planUninstall("claude-code");
    const result = await runAction(action, {
      which: () => "/usr/local/bin/claude",
      run: async (_command, args) => {
        if (args[1] === "get") {
          return { exitCode: 0, stdout: "talking-stick: tt mcp", stderr: "" };
        }
        throw new Error("spawn /usr/local/bin/claude EACCES");
      }
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.message).toBe("spawn /usr/local/bin/claude EACCES");
  });
});

test("SUPPORTED_HARNESSES is the full expected set", () => {
  expect([...SUPPORTED_HARNESSES].sort()).toEqual(["claude-code", "codex", "gemini", "grok", "opencode"].sort());
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
