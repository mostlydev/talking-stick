import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MissingHarnessError,
  resolveHarnessConfigDir,
  skipAction,
  type HarnessId,
  type InstallAction,
  type InstallOptions
} from "./install.js";

export const DEFAULT_SKILL_NAME = "talking-stick";
const FILE_SKILL_HARNESSES = ["claude-code", "codex", "grok", "opencode"] as const;

export interface SkillInstallOptions extends InstallOptions {
  skillName?: string;
  sourcePath?: string;
  link?: boolean;
}

export type FileSkillHarness = (typeof FILE_SKILL_HARNESSES)[number];

export interface SkillSyncTargetResult {
  harness: FileSkillHarness;
  targetPath: string;
  status: "missing" | "current" | "updated" | "failed";
  message: string;
}

export interface SkillSyncResult {
  sourcePath: string;
  sourceDigest: string;
  targets: SkillSyncTargetResult[];
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
    case "grok":
      return path.join(
        resolveHarnessConfigDir("grok", options),
        "skills",
        options.skillName ?? DEFAULT_SKILL_NAME
      );
    case "opencode":
      return path.join(
        resolveHarnessConfigDir("opencode", options),
        "skills",
        options.skillName ?? DEFAULT_SKILL_NAME
      );
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
    const geminiTargetPath = path.join(
      resolveHarnessConfigDir("gemini", options),
      "skills",
      skillName
    );
    return shouldLink
      ? {
          kind: "exec",
          harness,
          command: "gemini",
          args: ["skills", "link", sourcePath, "--scope", "user", "--consent"],
          description: `gemini skills link ${sourcePath} --scope user --consent`,
          operation: "install",
          inspect: () => inspectInstalledSkill(sourcePath, geminiTargetPath, true)
        }
      : {
          kind: "exec",
          harness,
          command: "gemini",
          args: ["skills", "install", sourcePath, "--scope", "user", "--consent"],
          description: `gemini skills install ${sourcePath} --scope user --consent`,
          operation: "install",
          inspect: () => inspectInstalledSkill(sourcePath, geminiTargetPath, false)
        };
  }

  const targetPath = resolveSkillTargetPath(harness, options);
  const harnessRootPath = resolveHarnessConfigDir(harness, options);
  const pathExists = options.pathExists ?? fs.existsSync;
  if (options.skipMissing && !pathExists(harnessRootPath)) {
    return skipAction(harness, `harness config directory not found: ${harnessRootPath}`);
  }

  return {
    kind: "file-patch",
    harness,
    filePath: targetPath,
    description:
      shouldLink
        ? `link ${sourcePath} -> ${targetPath}`
        : `copy ${sourcePath} -> ${targetPath}`,
    operation: "install",
    inspect: () => inspectInstalledSkill(sourcePath, targetPath, shouldLink),
    apply: () =>
      installSkillDirectory(sourcePath, targetPath, harnessRootPath, shouldLink, options)
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
  const harnessRootPath = resolveHarnessConfigDir(harness, options);
  const pathExists = options.pathExists ?? fs.existsSync;
  if (options.skipMissing && !pathExists(harnessRootPath)) {
    return skipAction(harness, `harness config directory not found: ${harnessRootPath}`);
  }

  return {
    kind: "file-patch",
    harness,
    filePath: targetPath,
    description: `remove ${targetPath}`,
    apply: () => removeInstalledSkill(targetPath, harnessRootPath, options)
  };
}

export function syncInstalledSkills(
  options: SkillInstallOptions = {}
): SkillSyncResult {
  const sourcePath = resolveBundledSkillPath(options);
  ensureSkillSourceExists(sourcePath);
  const sourceDigest = digestDirectory(sourcePath);

  return {
    sourcePath,
    sourceDigest,
    targets: FILE_SKILL_HARNESSES.map((harness) =>
      syncInstalledFileSkill(harness, sourcePath, sourceDigest, options)
    )
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
  harnessRootPath: string,
  link: boolean,
  options: SkillInstallOptions
): void {
  const pathExists = options.pathExists ?? fs.existsSync;
  if (options.skipMissing && !pathExists(harnessRootPath)) {
    throw new MissingHarnessError(`harness config directory not found: ${harnessRootPath}`);
  }

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

function syncInstalledFileSkill(
  harness: FileSkillHarness,
  sourcePath: string,
  sourceDigest: string,
  options: SkillInstallOptions
): SkillSyncTargetResult {
  const targetPath = resolveSkillTargetPath(harness, options);
  const harnessRootPath = resolveHarnessConfigDir(harness, options);

  try {
    if (!fs.existsSync(harnessRootPath) || !fs.existsSync(targetPath)) {
      return {
        harness,
        targetPath,
        status: "missing",
        message: "skill is not installed"
      };
    }

    const targetStat = fs.lstatSync(targetPath);
    if (targetStat.isSymbolicLink()) {
      const currentTarget = fs.readlinkSync(targetPath);
      const resolvedCurrentTarget = path.resolve(
        path.dirname(targetPath),
        currentTarget
      );
      if (sameRealPath(resolvedCurrentTarget, sourcePath)) {
        return {
          harness,
          targetPath,
          status: "current",
          message: "symlink already points at bundled skill"
        };
      }

      fs.unlinkSync(targetPath);
      fs.symlinkSync(
        sourcePath,
        targetPath,
        process.platform === "win32" ? "junction" : "dir"
      );
      return {
        harness,
        targetPath,
        status: "updated",
        message: "relinked stale skill symlink"
      };
    }

    if (targetStat.isDirectory() && digestDirectory(targetPath) === sourceDigest) {
      return {
        harness,
        targetPath,
        status: "current",
        message: "copied skill is current"
      };
    }

    removeInstalledSkill(targetPath);
    fs.cpSync(sourcePath, targetPath, { recursive: true });
    return {
      harness,
      targetPath,
      status: "updated",
      message: "updated copied skill"
    };
  } catch (error) {
    return {
      harness,
      targetPath,
      status: "failed",
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function inspectInstalledSkill(
  sourcePath: string,
  targetPath: string,
  link: boolean
): "absent" | "present" | "different" {
  try {
    const stat = fs.lstatSync(targetPath);
    if (link) {
      if (!stat.isSymbolicLink()) {
        return "different";
      }
      const currentTarget = fs.readlinkSync(targetPath);
      const resolvedCurrentTarget = path.resolve(
        path.dirname(targetPath),
        currentTarget
      );
      return sameRealPath(resolvedCurrentTarget, sourcePath)
        ? "present"
        : "different";
    }

    if (stat.isDirectory() && digestDirectory(targetPath) === digestDirectory(sourcePath)) {
      return "present";
    }
    return "different";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "absent";
    }
    throw error;
  }
}

function removeInstalledSkill(
  targetPath: string,
  harnessRootPath?: string,
  options: SkillInstallOptions = {}
): void {
  const pathExists = options.pathExists ?? fs.existsSync;
  if (options.skipMissing && harnessRootPath && !pathExists(harnessRootPath)) {
    throw new MissingHarnessError(`harness config directory not found: ${harnessRootPath}`);
  }

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

function sameRealPath(left: string, right: string): boolean {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

function digestDirectory(dirPath: string): string {
  const hash = crypto.createHash("sha256");
  for (const filePath of listFiles(dirPath)) {
    const relativePath = path.relative(dirPath, filePath).split(path.sep).join("/");
    hash.update(relativePath);
    hash.update("\0");
    hash.update(fs.readFileSync(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function listFiles(dirPath: string): string[] {
  const entries = fs
    .readdirSync(dirPath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}
