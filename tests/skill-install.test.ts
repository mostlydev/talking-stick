import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  DEFAULT_SKILL_NAME,
  HARNESS_SKILL_MODELS,
  BUNDLED_SKILL_NAMES,
  removeDuplicateSkillInstalls,
  planSkillInstall,
  planSkillUninstall,
  planSharedSkillUninstall,
  resolveBundledSkillPath,
  resolveDuplicateSkillTargetPaths,
  resolvePrimarySkillTargetPath,
  resolveSharedAgentsSkillsDir,
  resolveSharedSkillTargetPath,
  resolveSkillTargetPath,
  runAction,
  skillLoadingModel,
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
    expect(resolveSharedAgentsSkillsDir({ homeDir: "/home/u" })).toBe(
      "/home/u/.agents/skills"
    );
    expect(resolveSharedSkillTargetPath({ homeDir: "/home/u" })).toBe(
      "/home/u/.agents/skills/rooms"
    );
    expect(
      resolveSkillTargetPath("claude-code", { homeDir: "/home/u" })
    ).toBe("/home/u/.claude/skills/rooms");
    expect(resolveSkillTargetPath("codex", { homeDir: "/home/u" })).toBe(
      "/home/u/.codex/skills/rooms"
    );
    expect(resolvePrimarySkillTargetPath("codex", { homeDir: "/home/u" })).toBe(
      "/home/u/.agents/skills/rooms"
    );
    expect(resolveSkillTargetPath("grok", { env: {}, homeDir: "/home/u" })).toBe(
      "/home/u/.grok/skills/rooms"
    );
    expect(
      resolveSkillTargetPath("grok", {
        env: { GROK_HOME: "/custom/grok" },
        homeDir: "/home/u"
      })
    ).toBe("/custom/grok/skills/rooms");
    expect(
      resolveSkillTargetPath("opencode", { env: {}, homeDir: "/home/u" })
    ).toBe(
      "/home/u/.config/opencode/skills/rooms"
    );
    expect(
      resolveSkillTargetPath("opencode", {
        env: { XDG_CONFIG_HOME: "/custom/config" },
        homeDir: "/home/u"
      })
    ).toBe(
      "/custom/config/opencode/skills/rooms"
    );
    expect(resolveSkillTargetPath("antigravity", { homeDir: "/home/u" })).toBe(
      "/home/u/.gemini/config/skills/rooms"
    );
    expect(resolvePrimarySkillTargetPath("antigravity", { homeDir: "/home/u" })).toBe(
      "/home/u/.gemini/config/skills/rooms"
    );
  });

  test("declares the converged skill loading model per harness", () => {
    expect(skillLoadingModel("claude-code")).toBe("proprietary");
    expect(skillLoadingModel("codex")).toBe("shared+proprietary");
    expect(skillLoadingModel("antigravity")).toBe("proprietary");
    expect(skillLoadingModel("grok")).toBe("shared+proprietary");
    expect(skillLoadingModel("opencode")).toBe("shared+proprietary");
  });

  test("resolves proprietary duplicate cleanup targets", () => {
    expect(resolveDuplicateSkillTargetPaths("codex", { homeDir: "/home/u" })).toEqual([
      "/home/u/.codex/skills/rooms"
    ]);
    expect(
      resolveDuplicateSkillTargetPaths("opencode", {
        env: {},
        homeDir: "/home/u"
      })
    ).toEqual([
      "/home/u/.config/opencode/skills/rooms",
      "/home/u/.opencode/skills/rooms"
    ]);
    expect(resolveDuplicateSkillTargetPaths("antigravity", { homeDir: "/home/u" })).toEqual([
      "/home/u/.gemini/skills/rooms",
      "/home/u/.gemini/antigravity-cli/skills/rooms"
    ]);
  });

  test("default install symlinks the skill into the shared agents skill directory for Codex", () => {
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

    const target = path.join(tempRoot, ".agents", "skills", "rooms");
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(target)).toBe(resolveBundledSkillPath());
  });

  test("linked shared install exposes out-of-band messaging guidance", () => {
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

    const target = path.join(tempRoot, ".agents", "skills", "rooms");
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    const skill = fs.readFileSync(path.join(target, "SKILL.md"), "utf8");
    expect(skill).toContain("tt instructions show --json");
    expect(skill).toContain("join result lists current members");
    expect(skill).toContain("tt wait --json");
    expect(skill).toContain("cursor saved in `cli-sessions.json`");
    expect(skill).toContain("Poll or resume that same handle");
    expect(skill).toContain("output is not magically injected");
    expect(skill).not.toContain("tt events --follow");
  });

  test("shared skill install does not require a proprietary harness config directory", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-skill-"));
    tempRoots.push(tempRoot);

    const action = planSkillInstall("codex", {
      homeDir: tempRoot,
      skipMissing: true
    });
    expect(action.kind).toBe("file-patch");

    const result = await runAction(action, { skipMissing: true });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(fs.existsSync(path.join(tempRoot, ".agents", "skills", "rooms"))).toBe(true);
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

    const target = path.join(tempRoot, ".agents", "skills", "rooms");
    expect(result.ok).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
  });

  test("second file skill install reports already_present without re-copying", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-skill-"));
    tempRoots.push(tempRoot);
    const action = planSkillInstall("codex", {
      homeDir: tempRoot
    });
    expect(action.kind).toBe("file-patch");

    const first = await runAction(action);
    const second = await runAction(action);

    expect(first.status).toBe("added");
    expect(second.status).toBe("already_present");
  });

  test("ordinary install preserves a customized copy and --replace overwrites it", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-skill-"));
    tempRoots.push(tempRoot);
    const sourcePath = path.join(tempRoot, "source-skill");
    fs.mkdirSync(sourcePath, { recursive: true });
    fs.writeFileSync(path.join(sourcePath, "SKILL.md"), "bundled\n");
    const target = path.join(tempRoot, ".agents", "skills", "rooms");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "SKILL.md"), "custom\n");

    const preserved = await runAction(
      planSkillInstall("codex", {
        homeDir: tempRoot,
        sourcePath,
        link: false
      }),
      { homeDir: tempRoot }
    );
    expect(preserved.status).toBe("update_available");
    expect(fs.readFileSync(path.join(target, "SKILL.md"), "utf8")).toBe("custom\n");

    const replaced = await runAction(
      planSkillInstall("codex", {
        homeDir: tempRoot,
        sourcePath,
        link: false,
        replace: true
      }),
      { homeDir: tempRoot }
    );
    expect(replaced.status).toBe("updated");
    expect(fs.readFileSync(path.join(target, "SKILL.md"), "utf8")).toBe("bundled\n");
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

    const target = path.join(tempRoot, ".claude", "skills", "rooms");
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

    const target = path.join(tempRoot, ".claude", "skills", "rooms");
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
    const skill = fs.readFileSync(path.join(target, "SKILL.md"), "utf8");
    expect(skill).toContain("tt instructions show --json");
    expect(skill).toContain("join result lists current members");
    expect(skill).toContain("tt wait --json");
    expect(skill).toContain("cursor saved in `cli-sessions.json`");
    expect(skill).toContain("Poll or resume that same handle");
    expect(skill).toContain("output is not magically injected");
    expect(skill).not.toContain("tt events --follow");
  });

  test("syncInstalledSkills updates an existing copied shared skill without installing missing proprietary harnesses", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-skill-"));
    tempRoots.push(tempRoot);
    const sourcePath = path.join(tempRoot, "source-skill");
    fs.mkdirSync(sourcePath, { recursive: true });
    fs.writeFileSync(path.join(sourcePath, "SKILL.md"), "old skill\n");
    const install = planSkillInstall("codex", {
      homeDir: tempRoot,
      sourcePath,
      link: false
    });
    expect(install.kind).toBe("file-patch");
    if (install.kind !== "file-patch") throw new Error("unreachable");
    install.apply();
    fs.writeFileSync(path.join(sourcePath, "SKILL.md"), "new skill\n");

    const target = path.join(tempRoot, ".agents", "skills", "rooms");

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
    expect(fs.existsSync(path.join(tempRoot, ".codex"))).toBe(false);
  });

  test("every bundled skill ships with a frontmatter name matching its directory", () => {
    expect(BUNDLED_SKILL_NAMES).toEqual(["rooms", "rooms-oversee"]);
    for (const skillName of BUNDLED_SKILL_NAMES) {
      const source = resolveBundledSkillPath({ skillName });
      expect(path.basename(source)).toBe(skillName);
      expect(fs.readFileSync(path.join(source, "SKILL.md"), "utf8")).toMatch(new RegExp(`^---\nname: ${skillName}\ndescription: .+\n---\n`));
    }
  });

  test("rooms-oversee installs beside an existing rooms install and nowhere else", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-skill-"));
    tempRoots.push(tempRoot);
    const mainSource = resolveBundledSkillPath();
    const roomsSource = resolveBundledSkillPath({ skillName: "rooms-oversee" });
    // Claude Code and the shared folder have rooms; agy's folder exists without it.
    for (const dir of [".claude/skills", ".agents/skills"]) {
      fs.mkdirSync(path.join(tempRoot, dir), { recursive: true });
      fs.symlinkSync(mainSource, path.join(tempRoot, dir, "rooms"), "dir");
    }
    fs.mkdirSync(path.join(tempRoot, ".gemini", "config", "skills"), { recursive: true });
    const sync = () => syncInstalledSkills({ homeDir: tempRoot, skillName: "rooms-oversee", installBesideDefault: true });

    const first = sync();
    for (const dir of [".claude/skills", ".agents/skills"]) {
      expect(fs.readlinkSync(path.join(tempRoot, dir, "rooms-oversee"))).toBe(roomsSource);
    }
    expect(fs.existsSync(path.join(tempRoot, ".gemini", "config", "skills", "rooms-oversee"))).toBe(false);
    expect(first.targets.filter((target) => target.status === "updated").map((target) => target.targetPath).sort())
      .toEqual([path.join(tempRoot, ".agents/skills/rooms-oversee"), path.join(tempRoot, ".claude/skills/rooms-oversee")]);
    expect(sync().targets.filter((target) => target.status === "updated")).toEqual([]);

    // Without the flag a missing skill stays missing, as before.
    fs.unlinkSync(path.join(tempRoot, ".claude/skills/rooms-oversee"));
    expect(syncInstalledSkills({ homeDir: tempRoot, skillName: "rooms-oversee" }).targets
      .find((target) => target.harness === "claude-code")).toMatchObject({ status: "missing" });
    expect(fs.existsSync(path.join(tempRoot, ".claude/skills/rooms-oversee"))).toBe(false);
  });

  test("the rooms skill copies beside a copied install and never replaces a dangling link", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-skill-"));
    tempRoots.push(tempRoot);
    const roomsSource = resolveBundledSkillPath({ skillName: "rooms-oversee" });
    fs.cpSync(resolveBundledSkillPath(), path.join(tempRoot, ".claude/skills/rooms"), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, ".agents/skills"), { recursive: true });
    fs.symlinkSync(resolveBundledSkillPath(), path.join(tempRoot, ".agents/skills/rooms"), "dir");
    const dangling = path.join(tempRoot, ".agents/skills/rooms-oversee");
    fs.symlinkSync(path.join(tempRoot, "missing"), dangling, "dir");

    syncInstalledSkills({ homeDir: tempRoot, skillName: "rooms-oversee", installBesideDefault: true });
    const copied = path.join(tempRoot, ".claude/skills/rooms-oversee");
    expect(fs.lstatSync(copied).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(copied, "SKILL.md"), "utf8")).toBe(fs.readFileSync(path.join(roomsSource, "SKILL.md"), "utf8"));
    expect(fs.readlinkSync(dangling)).toBe(path.join(tempRoot, "missing"));
  });

  test("planSkillInstall installs a named bundled skill from its own directory", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-skill-"));
    tempRoots.push(tempRoot);
    fs.mkdirSync(path.join(tempRoot, ".claude"), { recursive: true });
    const action = planSkillInstall("claude-code", { homeDir: tempRoot, skillName: "rooms-oversee" });
    if (action.kind !== "file-patch") throw new Error("unreachable");
    action.apply();
    expect(fs.readlinkSync(path.join(tempRoot, ".claude", "skills", "rooms-oversee")))
      .toBe(resolveBundledSkillPath({ skillName: "rooms-oversee" }));
    const remove = planSkillUninstall("claude-code", { homeDir: tempRoot, skillName: "rooms-oversee" });
    if (remove.kind !== "file-patch") throw new Error("unreachable");
    remove.apply();
    expect(fs.existsSync(path.join(tempRoot, ".claude", "skills", "rooms-oversee"))).toBe(false);
  });

  test("syncInstalledSkills leaves current symlinks alone and preserves unknown symlinks", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-skill-"));
    tempRoots.push(tempRoot);
    const sourcePath = path.join(tempRoot, "source-skill");
    const staleSourcePath = path.join(tempRoot, "stale-skill");
    fs.mkdirSync(sourcePath, { recursive: true });
    fs.writeFileSync(path.join(sourcePath, "SKILL.md"), "current\n");
    fs.mkdirSync(staleSourcePath, { recursive: true });
    fs.writeFileSync(path.join(staleSourcePath, "SKILL.md"), "stale\n");

    const codexTarget = path.join(tempRoot, ".agents", "skills", "rooms");
    fs.mkdirSync(path.dirname(codexTarget), { recursive: true });
    fs.symlinkSync(sourcePath, codexTarget, "dir");
    const claudeTarget = path.join(tempRoot, ".claude", "skills", "rooms");
    fs.mkdirSync(path.dirname(claudeTarget), { recursive: true });
    fs.symlinkSync(staleSourcePath, claudeTarget, "dir");

    const result = syncInstalledSkills({
      homeDir: tempRoot,
      sourcePath
    });

    expect(fs.readlinkSync(codexTarget)).toBe(sourcePath);
    expect(fs.readlinkSync(claudeTarget)).toBe(staleSourcePath);
    expect(result.targets.find((target) => target.harness === "codex")).toMatchObject({
      status: "current"
    });
    expect(result.targets.find((target) => target.harness === "claude-code")).toMatchObject({
      status: "update_available"
    });
  });

  test("syncInstalledSkills preserves a customized copied skill and offers explicit replacement", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-skill-"));
    tempRoots.push(tempRoot);
    const sourcePath = path.join(tempRoot, "source-skill");
    fs.mkdirSync(sourcePath, { recursive: true });
    fs.writeFileSync(path.join(sourcePath, "SKILL.md"), "new bundled skill\n");
    const target = path.join(tempRoot, ".agents", "skills", "rooms");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "SKILL.md"), "custom skill\n");

    const result = syncInstalledSkills({ homeDir: tempRoot, sourcePath });
    expect(fs.readFileSync(path.join(target, "SKILL.md"), "utf8")).toBe("custom skill\n");
    expect(result.targets.find((item) => item.harness === "codex")).toMatchObject({
      status: "update_available",
      offer: true
    });
    const second = syncInstalledSkills({ homeDir: tempRoot, sourcePath });
    expect(second.targets.find((item) => item.harness === "codex")).toMatchObject({
      status: "update_available",
      offer: false
    });
  });

  test("uninstall removes an installed opencode proprietary duplicate directory", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-skill-"));
    tempRoots.push(tempRoot);

    const target = path.join(
      tempRoot,
      ".config",
      "opencode",
      "skills",
      "rooms"
    );
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "SKILL.md"), "old\n");
    expect(fs.existsSync(target)).toBe(true);

    const uninstall = planSkillUninstall("opencode", {
      env: { XDG_CONFIG_HOME: path.join(tempRoot, ".config") },
      homeDir: tempRoot
    });
    expect(uninstall.kind).toBe("file-patch");
    if (uninstall.kind !== "file-patch") {
      throw new Error("unreachable");
    }
    uninstall.apply();

    expect(fs.existsSync(target)).toBe(false);
  });

  test("shared uninstall removes only the talking-stick skill subdirectory", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-skill-"));
    tempRoots.push(tempRoot);
    const sharedSkill = path.join(tempRoot, ".agents", "skills", "rooms");
    const otherSkill = path.join(tempRoot, ".agents", "skills", "other-skill");
    fs.mkdirSync(sharedSkill, { recursive: true });
    fs.mkdirSync(otherSkill, { recursive: true });
    fs.writeFileSync(path.join(sharedSkill, "SKILL.md"), "old\n");
    fs.writeFileSync(path.join(otherSkill, "SKILL.md"), "keep\n");

    const uninstall = planSharedSkillUninstall({ homeDir: tempRoot });
    expect(uninstall.kind).toBe("file-patch");
    if (uninstall.kind !== "file-patch") {
      throw new Error("unreachable");
    }
    uninstall.apply();

    expect(fs.existsSync(sharedSkill)).toBe(false);
    expect(fs.existsSync(otherSkill)).toBe(true);
    expect(fs.existsSync(path.join(tempRoot, ".agents", "skills"))).toBe(true);
  });

  test("duplicate cleanup keeps agy's old link until agy's own folder holds the skill", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-skill-"));
    tempRoots.push(tempRoot);
    const sourcePath = resolveBundledSkillPath();
    const old = path.join(tempRoot, ".gemini", "skills", "rooms");
    const primary = path.join(tempRoot, ".gemini", "config", "skills", "rooms");
    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.symlinkSync(sourcePath, old, "dir");
    const cleanup = () => removeDuplicateSkillInstalls({
      harnesses: ["antigravity"], reason: "manual", homeDir: tempRoot, sourcePath, audit: { append: () => {} }
    });

    // Nothing installed in agy's folder: the old link is agy's only copy.
    expect(cleanup()).toEqual([
      expect.objectContaining({ harness: "antigravity", action: "preserved", message: expect.stringContaining("does not hold the skill") }),
      expect.objectContaining({ harness: "antigravity", action: "absent" })
    ]);
    expect(fs.lstatSync(old).isSymbolicLink()).toBe(true);

    // Something else occupies agy's folder: still kept.
    fs.mkdirSync(primary, { recursive: true });
    fs.writeFileSync(path.join(primary, "SKILL.md"), "someone else's\n");
    expect(cleanup()[0]).toMatchObject({ action: "preserved" });
    expect(fs.lstatSync(old).isSymbolicLink()).toBe(true);

    // Once agy's folder holds the skill, the old link goes.
    fs.rmSync(primary, { recursive: true });
    fs.symlinkSync(sourcePath, primary, "dir");
    expect(cleanup()[0]).toMatchObject({ action: "removed" });
    expect(fs.lstatSync(old, { throwIfNoEntry: false })).toBeUndefined();
  });

  test("duplicate cleanup removes only symlinks pointing at the bundled skill", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-skill-"));
    tempRoots.push(tempRoot);
    const sourcePath = resolveBundledSkillPath();
    const codexDuplicate = path.join(tempRoot, ".codex", "skills", "rooms");
    fs.mkdirSync(path.dirname(codexDuplicate), { recursive: true });
    fs.symlinkSync(sourcePath, codexDuplicate, "dir");
    const unknownDuplicate = path.join(
      tempRoot,
      ".config",
      "opencode",
      "skills",
      "rooms"
    );
    fs.mkdirSync(unknownDuplicate, { recursive: true });
    fs.writeFileSync(path.join(unknownDuplicate, "SKILL.md"), "custom\n");
    const legacyOpencodeDuplicate = path.join(
      tempRoot,
      ".opencode",
      "skills",
      "rooms"
    );
    fs.mkdirSync(path.dirname(legacyOpencodeDuplicate), { recursive: true });
    fs.symlinkSync(sourcePath, legacyOpencodeDuplicate, "dir");
    // Codex and OpenCode already read the skill from the shared folder.
    const shared = path.join(tempRoot, ".agents", "skills", "rooms");
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.symlinkSync(sourcePath, shared, "dir");

    const audit: unknown[] = [];
    const results = removeDuplicateSkillInstalls({
      harnesses: ["codex", "opencode"],
      reason: "manual",
      env: { XDG_CONFIG_HOME: path.join(tempRoot, ".config") },
      homeDir: tempRoot,
      sourcePath,
      audit: { append: (entry) => audit.push(entry) }
    });

    expect(fs.existsSync(codexDuplicate)).toBe(false);
    expect(fs.existsSync(legacyOpencodeDuplicate)).toBe(false);
    expect(fs.existsSync(unknownDuplicate)).toBe(true);
    expect(results).toEqual([
      expect.objectContaining({ harness: "codex", action: "removed" }),
      expect.objectContaining({ harness: "opencode", action: "preserved" }),
      expect.objectContaining({ harness: "opencode", action: "removed" })
    ]);
    expect(audit).toHaveLength(3);
  });
});
