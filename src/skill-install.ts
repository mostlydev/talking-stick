import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FILE_SKILL_HARNESSES,
  HARNESS_SKILL_MODELS,
  SUPPORTED_HARNESSES,
  type FileSkillHarness,
  type HarnessId,
  type SkillLoadingModel
} from "./harness-model.js";
import type { AuditLog, AuditReason } from "./install-audit.js";
import type { CleanupResult } from "./install-audit.js";
import {
  digestDirectory,
  getManagedContent,
  recordManagedContent,
  recordManagedContentOffer
} from "./managed-content.js";
import {
  MissingHarnessError,
  resolveHarnessConfigDir,
  skipAction,
  type InstallAction,
  type InstallOptions,
  type InstallTargetState
} from "./install.js";

export const DEFAULT_SKILL_NAME = "talking-stick";
export { FILE_SKILL_HARNESSES } from "./harness-model.js";
export type { FileSkillHarness } from "./harness-model.js";

export interface SkillInstallOptions extends InstallOptions {
  skillName?: string;
  sourcePath?: string;
  link?: boolean;
  replace?: boolean;
  markOffers?: boolean;
}

export interface SkillSyncTargetResult {
  harness: FileSkillHarness;
  targetPath: string;
  status: "missing" | "current" | "updated" | "update_available" | "failed";
  message: string;
  offer?: boolean;
}

export interface SkillSyncResult {
  sourcePath: string;
  sourceDigest: string;
  targets: SkillSyncTargetResult[];
}

export interface RemoveDuplicateSkillOptions extends SkillInstallOptions {
  harnesses?: readonly HarnessId[] | "all";
  reason: AuditReason;
  packageVersionFrom?: string;
  packageVersionTo?: string;
  audit?: AuditLog;
}

export function resolveBundledSkillPath(options: SkillInstallOptions = {}): string {
  return options.sourcePath ?? path.resolve(currentPackageDir(), "skills", DEFAULT_SKILL_NAME);
}

export function resolveSharedAgentsSkillsDir(
  options: SkillInstallOptions = {}
): string {
  const homeDir = options.homeDir ?? process.env.HOME ?? "";
  return path.join(homeDir, ".agents", "skills");
}

export function resolveSharedSkillTargetPath(
  options: SkillInstallOptions = {}
): string {
  return path.join(
    resolveSharedAgentsSkillsDir(options),
    options.skillName ?? DEFAULT_SKILL_NAME
  );
}

export function skillLoadingModel(harness: HarnessId): SkillLoadingModel {
  return HARNESS_SKILL_MODELS[harness].skillLoadingModel;
}

export function resolvePrimarySkillTargetPath(
  harness: FileSkillHarness,
  options: SkillInstallOptions = {}
): string {
  const model = skillLoadingModel(harness);
  if (model === "shared" || model === "shared+proprietary") {
    return resolveSharedSkillTargetPath(options);
  }
  return resolveSkillTargetPath(harness, options);
}

export function resolveLegacyOpencodeSkillTargetPath(
  options: SkillInstallOptions = {}
): string {
  const homeDir = options.homeDir ?? process.env.HOME ?? "";
  return path.join(
    homeDir,
    ".opencode",
    "skills",
    options.skillName ?? DEFAULT_SKILL_NAME
  );
}

export function resolveDuplicateSkillTargetPaths(
  harness: HarnessId,
  options: SkillInstallOptions = {}
): string[] {
  const skillName = options.skillName ?? DEFAULT_SKILL_NAME;
  switch (harness) {
    case "claude-code":
    case "antigravity":
      return [];
    case "codex":
      return [resolveSkillTargetPath("codex", options)];
    case "grok":
      return [resolveSkillTargetPath("grok", options)];
    case "opencode":
      return [
        resolveSkillTargetPath("opencode", options),
        resolveLegacyOpencodeSkillTargetPath(options)
      ];
    case "gemini":
      return [path.join(resolveHarnessConfigDir("gemini", options), "skills", skillName)];
    default:
      throw new Error(`Unknown duplicate skill cleanup harness: ${harness satisfies never}`);
  }
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
    case "antigravity":
      return resolveSharedSkillTargetPath(options);
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
    return skipAction(
      harness,
      `Gemini CLI skill install is deprecated; use tt install antigravity. Cleanup will remove ${path.join(
        resolveHarnessConfigDir("gemini", options),
        "skills",
        skillName
      )} when it is a Talking Stick-managed symlink.`
    );
  }

  const targetPath = resolvePrimarySkillTargetPath(harness, options);
  const harnessRootPath =
    skillLoadingModel(harness) === "shared" ||
    skillLoadingModel(harness) === "shared+proprietary"
      ? undefined
      : resolveHarnessConfigDir(harness, options);
  const pathExists = options.pathExists ?? fs.existsSync;
  if (options.skipMissing && harnessRootPath && !pathExists(harnessRootPath)) {
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
    inspect: () =>
      inspectInstalledSkillForUpdate(
        sourcePath,
        targetPath,
        shouldLink,
        options
      ),
    apply: () =>
      installSkillDirectory(sourcePath, targetPath, harnessRootPath, shouldLink, options)
  };
}

export function planSkillUninstall(
  harness: HarnessId,
  options: SkillInstallOptions = {}
): InstallAction {
  const skillName = options.skillName ?? DEFAULT_SKILL_NAME;

  if (harness === "antigravity") {
    return skipAction(
      harness,
      `shared skill left installed: ${resolveSharedSkillTargetPath(options)}`
    );
  }

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

export function planSharedSkillUninstall(
  options: SkillInstallOptions = {}
): InstallAction {
  const targetPath = resolveSharedSkillTargetPath(options);
  return {
    kind: "file-patch",
    harness: "antigravity",
    filePath: targetPath,
    description: `remove shared agents skill ${targetPath}`,
    operation: "uninstall",
    inspect: () => inspectInstalledPath(targetPath),
    apply: () => removeInstalledSkill(targetPath, undefined, options)
  };
}

export function syncInstalledSkills(
  options: SkillInstallOptions = {}
): SkillSyncResult {
  const sourcePath = resolveBundledSkillPath(options);
  ensureSkillSourceExists(sourcePath);
  const sourceDigest = digestDirectory(sourcePath);
  const syncTargets = dedupeSyncTargets(options);

  return {
    sourcePath,
    sourceDigest,
    targets: syncTargets.map((harness) =>
      syncInstalledFileSkill(harness, sourcePath, sourceDigest, options)
    )
  };
}

export function removeDuplicateSkillInstalls(
  options: RemoveDuplicateSkillOptions
): CleanupResult[] {
  const sourcePath = resolveBundledSkillPath(options);
  ensureSkillSourceExists(sourcePath);
  const harnesses =
    options.harnesses === undefined || options.harnesses === "all"
      ? SUPPORTED_HARNESSES
      : options.harnesses;
  const results: CleanupResult[] = [];

  for (const harness of harnesses) {
    const targets = dedupePaths(resolveDuplicateSkillTargetPaths(harness, options));
    if (targets.length === 0) {
      const result = {
        harness,
        action: "skipped" as const,
        message: `${harness}: no proprietary skill duplicate target`,
        target_type: "skill" as const
      };
      results.push(result);
      appendSkillCleanupAudit(options, result);
      continue;
    }

    for (const targetPath of targets) {
      const result = cleanupDuplicateSkillTarget(harness, targetPath, sourcePath);
      results.push(result);
      appendSkillCleanupAudit(options, result, targetPath);
    }
  }

  return results;
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const targetPath of paths) {
    const key = path.resolve(targetPath);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(targetPath);
  }
  return result;
}

function cleanupDuplicateSkillTarget(
  harness: HarnessId,
  targetPath: string,
  sourcePath: string
): CleanupResult {
  try {
    const stat = fs.lstatSync(targetPath);
    if (!stat.isSymbolicLink()) {
      return {
        harness,
        action: "preserved",
        message: `${targetPath} is not a Talking Stick-managed symlink; left in place.`,
        target_type: "skill"
      };
    }

    const currentTarget = fs.readlinkSync(targetPath);
    const resolvedCurrentTarget = path.resolve(path.dirname(targetPath), currentTarget);
    if (!sameRealPath(resolvedCurrentTarget, sourcePath)) {
      return {
        harness,
        action: "preserved",
        message: `${targetPath} points at ${resolvedCurrentTarget}; left in place.`,
        target_type: "skill"
      };
    }

    fs.unlinkSync(targetPath);
    return {
      harness,
      action: "removed",
      message: `Removed duplicate skill symlink ${targetPath}.`,
      target_type: "skill"
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        harness,
        action: "absent",
        message: `${targetPath} is already absent.`,
        target_type: "skill"
      };
    }
    return {
      harness,
      action: "failed",
      message: error instanceof Error ? error.message : String(error),
      target_type: "skill"
    };
  }
}

function appendSkillCleanupAudit(
  options: RemoveDuplicateSkillOptions,
  result: CleanupResult,
  targetPath?: string
): void {
  options.audit?.append({
    reason: options.reason,
    package_version_from: options.packageVersionFrom,
    package_version_to: options.packageVersionTo,
    harness: result.harness,
    target_type: "skill",
    config_path: targetPath,
    action: result.action,
    target_name: options.skillName ?? DEFAULT_SKILL_NAME,
    detail: result.message
  });
}

function dedupeSyncTargets(options: SkillInstallOptions): FileSkillHarness[] {
  const seen = new Set<string>();
  const targets: FileSkillHarness[] = [];
  for (const harness of FILE_SKILL_HARNESSES) {
    const targetPath = resolvePrimarySkillTargetPath(harness, options);
    const key = path.resolve(targetPath);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(harness);
  }
  return targets;
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
  harnessRootPath: string | undefined,
  link: boolean,
  options: SkillInstallOptions
): void {
  const pathExists = options.pathExists ?? fs.existsSync;
  if (options.skipMissing && harnessRootPath && !pathExists(harnessRootPath)) {
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
    recordManagedContent(targetPath, "skill-copy", digestDirectory(sourcePath), options);
    return;
  }

  fs.cpSync(sourcePath, targetPath, { recursive: true });
  recordManagedContent(targetPath, "skill-copy", digestDirectory(sourcePath), options);
}

function syncInstalledFileSkill(
  harness: FileSkillHarness,
  sourcePath: string,
  sourceDigest: string,
  options: SkillInstallOptions
): SkillSyncTargetResult {
  const targetPath = resolvePrimarySkillTargetPath(harness, options);
  const model = skillLoadingModel(harness);
  const harnessRootPath =
    model === "shared" || model === "shared+proprietary"
      ? path.dirname(resolveSharedAgentsSkillsDir(options))
      : resolveHarnessConfigDir(harness, options);

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
    const managed = getManagedContent(targetPath, options);
    if (targetStat.isSymbolicLink()) {
      const currentTarget = fs.readlinkSync(targetPath);
      const resolvedCurrentTarget = path.resolve(
        path.dirname(targetPath),
        currentTarget
      );
      if (sameRealPath(resolvedCurrentTarget, sourcePath)) {
        recordManagedContent(targetPath, "skill-copy", sourceDigest, options);
        return {
          harness,
          targetPath,
          status: "current",
          message: "symlink already points at bundled skill"
        };
      }

      const linkedDigest = fs.existsSync(resolvedCurrentTarget)
        ? digestDirectory(resolvedCurrentTarget)
        : null;
      if (
        options.replace !== true &&
        managed?.digest !== linkedDigest &&
        linkedDigest !== LEGACY_BUNDLED_SKILL_DIGEST
      ) {
        return skillUpdateAvailable(harness, targetPath, sourceDigest, options);
      }

      fs.unlinkSync(targetPath);
      fs.symlinkSync(
        sourcePath,
        targetPath,
        process.platform === "win32" ? "junction" : "dir"
      );
      recordManagedContent(targetPath, "skill-copy", sourceDigest, options);
      return {
        harness,
        targetPath,
        status: "updated",
        message: "relinked stale skill symlink"
      };
    }

    if (targetStat.isDirectory() && digestDirectory(targetPath) === sourceDigest) {
      recordManagedContent(targetPath, "skill-copy", sourceDigest, options);
      return {
        harness,
        targetPath,
        status: "current",
        message: "copied skill is current"
      };
    }

    const targetDigest = targetStat.isDirectory()
      ? digestDirectory(targetPath)
      : null;
    if (
      options.replace !== true &&
      managed?.digest !== targetDigest &&
      targetDigest !== LEGACY_BUNDLED_SKILL_DIGEST
    ) {
      return skillUpdateAvailable(harness, targetPath, sourceDigest, options);
    }

    removeInstalledSkill(targetPath);
    fs.cpSync(sourcePath, targetPath, { recursive: true });
    recordManagedContent(targetPath, "skill-copy", sourceDigest, options);
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

const LEGACY_BUNDLED_SKILL_DIGEST =
  "7a89a8f72ef8377ddfc3eb67fb274af237275515e576f24272e6178c163591ed";

function skillUpdateAvailable(
  harness: FileSkillHarness,
  targetPath: string,
  sourceDigest: string,
  options: SkillInstallOptions
): SkillSyncTargetResult {
  return {
    harness,
    targetPath,
    status: "update_available",
    message: "customized installed skill was preserved",
    offer:
      options.markOffers === false
        ? true
        : recordManagedContentOffer(
            targetPath,
            sourceDigest,
            "skill-copy",
            options
          )
  };
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

function inspectInstalledSkillForUpdate(
  sourcePath: string,
  targetPath: string,
  link: boolean,
  options: SkillInstallOptions
): InstallTargetState {
  const state = inspectInstalledSkill(sourcePath, targetPath, link);
  if (state !== "different" || options.replace === true) return state;

  const managed = getManagedContent(targetPath, options);
  let targetDigest: string | null = null;
  try {
    const stat = fs.lstatSync(targetPath);
    const contentPath = stat.isSymbolicLink()
      ? path.resolve(path.dirname(targetPath), fs.readlinkSync(targetPath))
      : targetPath;
    if (fs.existsSync(contentPath) && fs.statSync(contentPath).isDirectory()) {
      targetDigest = digestDirectory(contentPath);
    }
  } catch {
    return "different";
  }

  return targetDigest === LEGACY_BUNDLED_SKILL_DIGEST ||
    managed?.digest === targetDigest
    ? "different"
    : "customized";
}

function inspectInstalledPath(targetPath: string): "absent" | "present" {
  try {
    fs.lstatSync(targetPath);
    return "present";
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
