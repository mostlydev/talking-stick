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
  runAction,
  syncInstalledSkills
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

  test("linked install exposes out-of-band messaging guidance", () => {
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
    expect(fs.readFileSync(path.join(target, "SKILL.md"), "utf8")).toContain(
      "### 4.5 Out-of-band messaging"
    );
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

  test("copy install includes out-of-band messaging guidance", () => {
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
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(target, "SKILL.md"), "utf8")).toContain(
      "### 4.5 Out-of-band messaging"
    );
  });

  test("syncInstalledSkills updates an existing copied skill without installing missing harnesses", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-skill-"));
    tempRoots.push(tempRoot);
    const sourcePath = path.join(tempRoot, "source-skill");
    fs.mkdirSync(sourcePath, { recursive: true });
    fs.writeFileSync(path.join(sourcePath, "SKILL.md"), "new skill\n");

    const target = path.join(tempRoot, ".codex", "skills", "talking-stick");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "SKILL.md"), "old skill\n");

    const result = syncInstalledSkills({
      homeDir: tempRoot,
      sourcePath
    });

    expect(fs.readFileSync(path.join(target, "SKILL.md"), "utf8")).toBe(
      "new skill\n"
    );
    expect(result.targets.find((targetResult) => targetResult.harness === "codex")).toMatchObject({
      status: "updated"
    });
    expect(fs.existsSync(path.join(tempRoot, ".claude"))).toBe(false);
  });

  test("syncInstalledSkills leaves current symlinks alone and relinks stale ones", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-skill-"));
    tempRoots.push(tempRoot);
    const sourcePath = path.join(tempRoot, "source-skill");
    const staleSourcePath = path.join(tempRoot, "stale-skill");
    fs.mkdirSync(sourcePath, { recursive: true });
    fs.writeFileSync(path.join(sourcePath, "SKILL.md"), "current\n");
    fs.mkdirSync(staleSourcePath, { recursive: true });
    fs.writeFileSync(path.join(staleSourcePath, "SKILL.md"), "stale\n");

    const codexTarget = path.join(tempRoot, ".codex", "skills", "talking-stick");
    fs.mkdirSync(path.dirname(codexTarget), { recursive: true });
    fs.symlinkSync(sourcePath, codexTarget, "dir");
    const claudeTarget = path.join(tempRoot, ".claude", "skills", "talking-stick");
    fs.mkdirSync(path.dirname(claudeTarget), { recursive: true });
    fs.symlinkSync(staleSourcePath, claudeTarget, "dir");

    const result = syncInstalledSkills({
      homeDir: tempRoot,
      sourcePath
    });

    expect(fs.readlinkSync(codexTarget)).toBe(sourcePath);
    expect(fs.readlinkSync(claudeTarget)).toBe(sourcePath);
    expect(result.targets.find((target) => target.harness === "codex")).toMatchObject({
      status: "current"
    });
    expect(result.targets.find((target) => target.harness === "claude-code")).toMatchObject({
      status: "updated"
    });
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
