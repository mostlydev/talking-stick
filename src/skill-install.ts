import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  HarnessId,
  InstallAction,
  InstallOptions
} from "./install.js";

export const DEFAULT_SKILL_NAME = "talking-stick";

export interface SkillInstallOptions extends InstallOptions {
  skillName?: string;
  sourcePath?: string;
  link?: boolean;
}

export function resolveBundledSkillPath(options: SkillInstallOptions = {}): string {
  return options.sourcePath ?? path.resolve(currentPackageDir(), "skills", DEFAULT_SKILL_NAME);
}

export function resolveSkillTargetPath(
  harness: Exclude<HarnessId, "gemini">,
  options: SkillInstallOptions = {}
): string {
  const homeDir = options.homeDir ?? process.env.HOME ?? "";

  switch (harness) {
    case "claude-code":
      return path.join(homeDir, ".claude", "skills", options.skillName ?? DEFAULT_SKILL_NAME);
    case "codex":
      return path.join(homeDir, ".codex", "skills", options.skillName ?? DEFAULT_SKILL_NAME);
    case "opencode":
      return path.join(homeDir, ".opencode", "skills", options.skillName ?? DEFAULT_SKILL_NAME);
    default:
      throw new Error(`Unknown skill-install harness: ${harness satisfies never}`);
  }
}

export function planSkillInstall(
  harness: HarnessId,
  options: SkillInstallOptions = {}
): InstallAction {
  const skillName = options.skillName ?? DEFAULT_SKILL_NAME;
  const sourcePath = resolveBundledSkillPath(options);
  const shouldLink = options.link ?? true;

  ensureSkillSourceExists(sourcePath);

  if (harness === "gemini") {
    return shouldLink
      ? {
          kind: "exec",
          harness,
          command: "gemini",
          args: ["skills", "link", sourcePath, "--scope", "user", "--consent"],
          description: `gemini skills link ${sourcePath} --scope user --consent`
        }
      : {
          kind: "exec",
          harness,
          command: "gemini",
          args: ["skills", "install", sourcePath, "--scope", "user", "--consent"],
          description: `gemini skills install ${sourcePath} --scope user --consent`
        };
  }

  const targetPath = resolveSkillTargetPath(harness, options);
  return {
    kind: "file-patch",
    harness,
    filePath: targetPath,
    description:
      shouldLink
        ? `link ${sourcePath} -> ${targetPath}`
        : `copy ${sourcePath} -> ${targetPath}`,
    apply: () => installSkillDirectory(sourcePath, targetPath, shouldLink)
  };
}

export function planSkillUninstall(
  harness: HarnessId,
  options: SkillInstallOptions = {}
): InstallAction {
  const skillName = options.skillName ?? DEFAULT_SKILL_NAME;

  if (harness === "gemini") {
    return {
      kind: "exec",
      harness,
      command: "gemini",
      args: ["skills", "uninstall", skillName, "--scope", "user"],
      description: `gemini skills uninstall ${skillName} --scope user`
    };
  }

  const targetPath = resolveSkillTargetPath(harness, options);
  return {
    kind: "file-patch",
    harness,
    filePath: targetPath,
    description: `remove ${targetPath}`,
    apply: () => removeInstalledSkill(targetPath)
  };
}

function currentPackageDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function ensureSkillSourceExists(sourcePath: string): void {
  const skillFile = path.join(sourcePath, "SKILL.md");
  if (!fs.existsSync(skillFile)) {
    throw new Error(`Talking Stick skill source not found at ${sourcePath}`);
  }
}

function installSkillDirectory(
  sourcePath: string,
  targetPath: string,
  link: boolean
): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  removeInstalledSkill(targetPath);

  if (link) {
    fs.symlinkSync(
      sourcePath,
      targetPath,
      process.platform === "win32" ? "junction" : "dir"
    );
    return;
  }

  fs.cpSync(sourcePath, targetPath, { recursive: true });
}

function removeInstalledSkill(targetPath: string): void {
  try {
    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(targetPath);
      return;
    }
    fs.rmSync(targetPath, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}
