import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { parseHarnessList, planSessionHooks, runAction } from "../src/install.js";
import { planSkillInstall, resolvePrimarySkillTargetPath } from "../src/skill-install.js";
import { parseLaunchAgents } from "../src/workspace-launch.js";
import { builtinAdapters } from "../src/supervisor/adapters/index.js";

const supported = [
  { executable: "claude", install: "claude-code", worker: "claude", skills: [".claude", "skills"], hooks: [".claude", "settings.json"] },
  { executable: "codex", install: "codex", worker: "codex", skills: [".agents", "skills"], hooks: [".codex", "hooks.json"] },
  { executable: "grok", install: "grok", worker: "grok", skills: [".agents", "skills"], hooks: [".grok", "hooks", "talking-stick-lifecycle.json"] },
  { executable: "agy", install: "antigravity", worker: "antigravity", skills: [".gemini", "config", "skills"], hooks: [".gemini", "config", "hooks.json"] }
] as const;

const profiles: string[] = [];
afterEach(() => {
  for (const profile of profiles.splice(0)) fs.rmSync(profile, { recursive: true, force: true });
});

test.each(supported)("$executable ships both skills, lifecycle hooks, and a resumable headless worker", async harness => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "shrooms-harness-"));
  profiles.push(homeDir);
  if (harness.executable !== "agy") fs.mkdirSync(path.join(homeDir, harness.hooks[0]));
  const options = {
    homeDir,
    env: { HOME: homeDir },
    skipMissing: true,
    which: (name: string) => name === harness.executable ? path.join(homeDir, "bin", name) : null
  };
  expect(parseHarnessList([harness.executable])).toEqual([harness.install]);
  expect(parseLaunchAgents(harness.executable)).toEqual([harness.worker]);

  for (const skillName of ["rooms", "rooms-oversee"]) {
    const skillOptions = { ...options, skillName };
    const destination = path.join(homeDir, ...harness.skills, skillName);
    expect(resolvePrimarySkillTargetPath(harness.install, skillOptions)).toBe(destination);
    const result = await runAction(planSkillInstall(harness.install, skillOptions), skillOptions);
    expect(result.status).not.toBe("failed");
    expect(fs.readFileSync(path.join(destination, "SKILL.md"), "utf8")).toContain(`name: ${skillName}\n`);
  }

  const [hook] = planSessionHooks(harness.install, "install", options);
  expect(hook).toMatchObject({ kind: "file-patch", filePath: path.join(homeDir, ...harness.hooks) });
  expect((await runAction(hook, options)).status).not.toBe("failed");
  expect(fs.readFileSync(path.join(homeDir, ...harness.hooks), "utf8")).toContain("SessionStart");

  const adapter = builtinAdapters()[harness.worker];
  expect(adapter?.harness).toBe(harness.worker);
  if (process.platform !== "win32") {
    expect(adapter?.capabilities()).toMatchObject({ prompt: true, resume: true, interrupt: true });
  }
});
