import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  DEFAULT_SKILL_NAME,
  planSkillInstall,
  planSkillUninstall,
  resolveBundledSkillPath,
  resolveSkillTargetPath,
  runAction
} from "../src/index.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe("talking-stick skill install", () => {
  test("bundled talking-stick skill is present in the package source", () => {
    const bundledPath = resolveBundledSkillPath();

    expect(path.basename(bundledPath)).toBe(DEFAULT_SKILL_NAME);
    expect(fs.existsSync(path.join(bundledPath, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(bundledPath, "agents", "openai.yaml"))).toBe(
      true
    );
  });

  test("resolves harness skill targets in the expected global directories", () => {
    expect(
      resolveSkillTargetPath("claude-code", { homeDir: "/home/u" })
    ).toBe("/home/u/.claude/skills/talking-stick");
    expect(resolveSkillTargetPath("codex", { homeDir: "/home/u" })).toBe(
      "/home/u/.codex/skills/talking-stick"
    );
    expect(resolveSkillTargetPath("opencode", { homeDir: "/home/u" })).toBe(
      "/home/u/.opencode/skills/talking-stick"
    );
  });

  test("gemini links skills by default and can be forced to copy", () => {
    const sourcePath = resolveBundledSkillPath();
    const linkAction = planSkillInstall("gemini", {
      sourcePath
    });
    expect(linkAction.kind).toBe("exec");
    if (linkAction.kind !== "exec") {
      throw new Error("unreachable");
    }
    expect(linkAction.description).toBe(
      `gemini skills link ${sourcePath} --scope user --consent`
    );

    const copyAction = planSkillInstall("gemini", {
      sourcePath,
      link: false
    });
    expect(copyAction.kind).toBe("exec");
    if (copyAction.kind !== "exec") {
      throw new Error("unreachable");
    }
    expect(copyAction.description).toBe(
      `gemini skills install ${sourcePath} --scope user --consent`
    );
  });

  test("default install symlinks the skill into the codex global skill directory", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-skill-"));
    tempRoots.push(tempRoot);

    const action = planSkillInstall("codex", {
      homeDir: tempRoot
    });
    expect(action.kind).toBe("file-patch");
    if (action.kind !== "file-patch") {
      throw new Error("unreachable");
    }

    action.apply();

    const target = path.join(tempRoot, ".codex", "skills", "talking-stick");
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(target)).toBe(resolveBundledSkillPath());
  });

  test("skips skill install when the harness config directory is missing", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-skill-"));
    tempRoots.push(tempRoot);

    const action = planSkillInstall("codex", {
      homeDir: tempRoot,
      skipMissing: true
    });
    expect(action.kind).toBe("skip");

    const result = await runAction(action, { skipMissing: true });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(fs.existsSync(path.join(tempRoot, ".codex"))).toBe(false);
  });

  test("skill install proceeds when skipMissing is set and the harness config directory exists", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-skill-"));
    tempRoots.push(tempRoot);
    fs.mkdirSync(path.join(tempRoot, ".codex"));

    const action = planSkillInstall("codex", {
      homeDir: tempRoot,
      skipMissing: true
    });
    expect(action.kind).toBe("file-patch");

    const result = await runAction(action, { skipMissing: true });

    const target = path.join(tempRoot, ".codex", "skills", "talking-stick");
    expect(result.ok).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
  });

  test("copy install remains available for claude global skill directory", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-skill-"));
    tempRoots.push(tempRoot);

    const action = planSkillInstall("claude-code", {
      homeDir: tempRoot,
      link: false
    });
    expect(action.kind).toBe("file-patch");
    if (action.kind !== "file-patch") {
      throw new Error("unreachable");
    }

    action.apply();

    const target = path.join(tempRoot, ".claude", "skills", "talking-stick");
    expect(fs.existsSync(path.join(target, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(target, "agents", "openai.yaml"))).toBe(true);
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
  });

  test("uninstall removes an installed opencode skill directory", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-skill-"));
    tempRoots.push(tempRoot);

    const install = planSkillInstall("opencode", { homeDir: tempRoot });
    if (install.kind !== "file-patch") {
      throw new Error("expected file-patch install");
    }
    install.apply();

    const target = path.join(tempRoot, ".opencode", "skills", "talking-stick");
    expect(fs.existsSync(target)).toBe(true);

    const uninstall = planSkillUninstall("opencode", { homeDir: tempRoot });
    expect(uninstall.kind).toBe("file-patch");
    if (uninstall.kind !== "file-patch") {
      throw new Error("unreachable");
    }
    uninstall.apply();

    expect(fs.existsSync(target)).toBe(false);
  });
});
