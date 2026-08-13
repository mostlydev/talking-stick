import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildGrokSessionHookConfig,
  detectHarness,
  GROK_SESSION_HOOK_EVENTS,
  parseHarnessList,
  planGrokSessionHookInstall,
  planGrokSessionHookUninstall,
  resolveGrokSessionHookPath,
  resolveHarnessConfigDir,
  resolveOpencodeConfigDir,
  runAction
} from "../src/install.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("harness paths and detection", () => {
  test("resolves harness config roots and honors XDG/GROK overrides", () => {
    expect(resolveHarnessConfigDir("claude-code", { homeDir: "/home/u" })).toBe("/home/u/.claude");
    expect(resolveHarnessConfigDir("codex", { homeDir: "/home/u" })).toBe("/home/u/.codex");
    expect(resolveOpencodeConfigDir({
      homeDir: "/home/u",
      env: { XDG_CONFIG_HOME: "/xdg" }
    })).toBe("/xdg/opencode");
    expect(resolveGrokSessionHookPath({
      homeDir: "/home/u",
      env: { GROK_HOME: "/grok" }
    })).toBe("/grok/hooks/talking-stick-session.json");
  });

  test("detects binaries and existing config roots", () => {
    expect(detectHarness("codex", { which: () => "/bin/codex" }).detected).toBe(true);
    expect(detectHarness("opencode", {
      homeDir: "/home/u",
      env: {},
      which: () => null,
      readFile: () => "{}"
    }).detected).toBe(true);
  });

  test("parses, deduplicates, and validates harness names", () => {
    expect(parseHarnessList(["codex", "claude", "claude-code", "codex"])).toEqual([
      "codex",
      "claude-code"
    ]);
    expect(() => parseHarnessList(["unknown"])).toThrow(/Unknown harness/);
  });
});

describe("Grok session hook", () => {
  test("uses identity lifecycle events and excludes per-tool hooks", () => {
    expect(GROK_SESSION_HOOK_EVENTS).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "SessionEnd"
    ]);
    const config = JSON.parse(buildGrokSessionHookConfig()) as {
      hooks: Record<string, unknown>;
    };
    expect(Object.keys(config.hooks)).toEqual(GROK_SESSION_HOOK_EVENTS);
    expect(config.hooks).not.toHaveProperty("PreToolUse");
  });

  test("installs idempotently and uninstalls the hook", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-install-"));
    roots.push(homeDir);
    fs.mkdirSync(path.join(homeDir, ".grok"), { recursive: true });
    const options = { homeDir, env: {}, skipMissing: true };
    const install = planGrokSessionHookInstall(options);
    const first = await runAction(install, options);
    const second = await runAction(install, options);
    const hookPath = resolveGrokSessionHookPath(options);

    expect(first.status).toBe("added");
    expect(second.status).toBe("already_present");
    expect(fs.readFileSync(hookPath, "utf8")).toBe(buildGrokSessionHookConfig());

    const removed = await runAction(planGrokSessionHookUninstall(options), options);
    expect(removed.status).toBe("removed");
    expect(fs.existsSync(hookPath)).toBe(false);
  });

  test("updates an older per-tool hook to the lifecycle-only config", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-install-"));
    roots.push(homeDir);
    const hookPath = resolveGrokSessionHookPath({ homeDir, env: {} });
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(
      hookPath,
      JSON.stringify({
        hooks: {
          SessionStart: [],
          UserPromptSubmit: [],
          PreToolUse: [],
          SessionEnd: []
        }
      }),
      "utf8"
    );
    const options = { homeDir, env: {}, skipMissing: true };

    const updated = await runAction(planGrokSessionHookInstall(options), options);
    expect(updated.status).toBe("updated");
    const config = JSON.parse(fs.readFileSync(hookPath, "utf8")) as {
      hooks: Record<string, unknown>;
    };
    expect(Object.keys(config.hooks)).toEqual(GROK_SESSION_HOOK_EVENTS);
  });

  test("skips install when the harness root is absent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-install-missing-"));
    roots.push(root);
    const options = { homeDir: root, env: {}, skipMissing: true };
    expect((await runAction(planGrokSessionHookInstall(options), options)).status).toBe("skipped");
  });
});
