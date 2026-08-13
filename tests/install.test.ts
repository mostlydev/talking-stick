import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildGrokSessionHookConfig,
  CLAUDE_STOP_GUARD_MARKER,
  mergeClaudeStopGuard,
  planClaudeStopGuardInstall,
  planClaudeStopGuardUninstall,
  removeClaudeStopGuard,
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

describe("Claude Stop guard", () => {
  function setupHome(): { homeDir: string; settingsPath: string } {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-guard-"));
    roots.push(homeDir);
    fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
    return {
      homeDir,
      settingsPath: path.join(homeDir, ".claude", "settings.json")
    };
  }

  test("merge preserves foreign settings and is idempotent", () => {
    const existing = JSON.stringify(
      {
        model: "opus",
        hooks: {
          SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "other.sh" }] }],
          Stop: [{ hooks: [{ type: "command", command: "foreign-stop.sh" }] }]
        }
      },
      null,
      2
    );
    const merged = mergeClaudeStopGuard(existing);
    expect(merged).not.toBeNull();
    const parsed = JSON.parse(merged!) as {
      model: string;
      hooks: { SessionStart: unknown[]; Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(parsed.model).toBe("opus");
    expect(parsed.hooks.SessionStart).toHaveLength(1);
    expect(parsed.hooks.Stop).toHaveLength(2);
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe("foreign-stop.sh");
    expect(parsed.hooks.Stop[1].hooks[0].command).toContain(CLAUDE_STOP_GUARD_MARKER);
    expect(parsed.hooks.Stop[1].hooks[0].command).toContain('rc=$?; if [ "$rc" -eq 2 ]; then exit 2; fi');

    expect(mergeClaudeStopGuard(merged)).toBe(merged);
  });

  test("merge refuses unparseable settings; remove strips only our entry", () => {
    expect(mergeClaudeStopGuard("{ not json")).toBeNull();

    const merged = mergeClaudeStopGuard(null)!;
    const removed = removeClaudeStopGuard(merged)!;
    const parsed = JSON.parse(removed) as Record<string, unknown>;
    expect(parsed.hooks).toBeUndefined();

    const withForeign = mergeClaudeStopGuard(
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "foreign.sh" }] }] } })
    )!;
    const strippedText = removeClaudeStopGuard(withForeign)!;
    const stripped = JSON.parse(strippedText) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(stripped.hooks.Stop).toHaveLength(1);
    expect(stripped.hooks.Stop[0].hooks[0].command).toBe("foreign.sh");
  });

  test("install action writes, is idempotent, and uninstall cleans", async () => {
    const { homeDir, settingsPath } = setupHome();
    const options = { homeDir, env: {}, skipMissing: true };

    const first = await runAction(planClaudeStopGuardInstall(options), options);
    const second = await runAction(planClaudeStopGuardInstall(options), options);
    expect(first.status).toBe("added");
    expect(second.status).toBe("already_present");
    expect(fs.readFileSync(settingsPath, "utf8")).toContain(CLAUDE_STOP_GUARD_MARKER);

    const removed = await runAction(planClaudeStopGuardUninstall(options), options);
    expect(removed.status).toBe("removed");
    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    expect(JSON.stringify(after)).not.toContain(CLAUDE_STOP_GUARD_MARKER);
  });

  test("install skips when the claude config directory is missing", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-guard-"));
    roots.push(homeDir);
    const options = { homeDir, env: {}, skipMissing: true };
    const action = planClaudeStopGuardInstall(options);
    expect(action.kind).toBe("skip");
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
