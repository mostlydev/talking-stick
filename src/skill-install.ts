import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HARNESS_SKILL_MODELS,
  SUPPORTED_HARNESSES,
  type HarnessId,
  type SkillLoadingModel
} from "./harness-model.js";
import type { AuditLog, AuditReason } from "./install-audit.js";
import type { CleanupResult } from "./install-audit.js";
import { isStandalone, standaloneInstallDir, standaloneLinkRoot } from "./standalone-mode.js";
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

export const DEFAULT_SKILL_NAME = "rooms";
// Installed alongside the default skill wherever it goes.
export const COMPANION_SKILL_NAMES = ["rooms-oversee"] as const;
export const BUNDLED_SKILL_NAMES: readonly string[] = [DEFAULT_SKILL_NAME, ...COMPANION_SKILL_NAMES];
/**
 * The names the bundled skills had before shrooms 0.39, each with its new name.
 * Their folders still ship as short redirect stubs, because installers from
 * 0.38.0 and earlier refuse an archive without skills/talking-stick/SKILL.md,
 * but they are never installed. Installs under these names move to the new ones.
 */
export const LEGACY_SKILL_RENAMES: ReadonlyArray<readonly [legacy: string, current: string]> = [
  ["talking-stick", DEFAULT_SKILL_NAME],
  ["talking-stick-rooms", "rooms-oversee"]
];
export const LEGACY_SKILL_NAMES: readonly string[] = LEGACY_SKILL_RENAMES.map(([legacy]) => legacy);

export interface SkillInstallOptions extends InstallOptions {
  skillName?: string;
  sourcePath?: string;
  link?: boolean;
  replace?: boolean;
  markOffers?: boolean;
  /** Sync only: install a missing skill where the default skill is installed. */
  installBesideDefault?: boolean;
}

export interface SkillSyncTargetResult {
  harness: HarnessId;
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
  return options.sourcePath ?? path.resolve(currentPackageDir(), "skills", options.skillName ?? DEFAULT_SKILL_NAME);
}

export function resolveSharedAgentsSkillsDir(
  options: SkillInstallOptions = {}
): string {
  const homeDir = options.homeDir ?? process.env.HOME ?? "";
  return path.join(homeDir, ".agents", "skills");
}

/** ~/.gemini, where agy keeps its config folder and its older skill folders. */
function resolveAgyLegacyHome(options: SkillInstallOptions): string {
  return path.dirname(resolveHarnessConfigDir("antigravity", options));
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
  harness: HarnessId,
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
      return [];
    case "antigravity":
      // Older agy releases read these; a managed link left there shows the skill twice.
      return [
        path.join(resolveAgyLegacyHome(options), "skills", skillName),
        path.join(resolveAgyLegacyHome(options), "antigravity-cli", "skills", skillName)
      ];
    case "codex":
      return [resolveSkillTargetPath("codex", options)];
    case "grok":
      return [resolveSkillTargetPath("grok", options)];
    case "opencode":
      return [
        resolveSkillTargetPath("opencode", options),
        resolveLegacyOpencodeSkillTargetPath(options)
      ];
    default:
      throw new Error(`Unknown duplicate skill cleanup harness: ${harness satisfies never}`);
  }
}

export function resolveSkillTargetPath(
  harness: HarnessId,
  options: SkillInstallOptions = {}
): string {
  const homeDir = options.homeDir ?? process.env.HOME ?? "";

  switch (harness) {
    case "claude-code":
      return path.join(homeDir, ".claude", "skills", options.skillName ?? DEFAULT_SKILL_NAME);
    case "codex":
      return path.join(homeDir, ".codex", "skills", options.skillName ?? DEFAULT_SKILL_NAME);
    case "antigravity":
      return path.join(
        resolveHarnessConfigDir("antigravity", options),
        "skills",
        options.skillName ?? DEFAULT_SKILL_NAME
      );
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
    harness: "codex",
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

export interface LegacySkillMigrationResult {
  legacyPath: string;
  newPath: string;
  status: "renamed" | "kept_customized" | "kept_occupied" | "failed";
  message: string;
  /** For a kept install: true the first time it is reported, so a hint shows once. */
  offer?: boolean;
}

export interface LegacySkillMigrationOptions extends SkillInstallOptions {
  /** Where a new link points; the standalone installer passes <install-dir>/current/skills/<name>. */
  linkSourceFor?: (skillName: string) => string;
}

/**
 * Moves skills installed under their pre-0.39 names to the new names. An old
 * install is replaced only when it is provably ours and unedited: a link into
 * this package, a release, or the npm copy whose content is the bundled skill,
 * the redirect stub, or what was recorded when it was made, or such a copy. The
 * new location is checked first; when someone else's content is already there,
 * the old install stays. Customized old installs always stay. Old duplicate
 * locations are cleaned up without getting the new name. Safe to repeat.
 */
export function migrateLegacySkillInstalls(options: LegacySkillMigrationOptions = {}): LegacySkillMigrationResult[] {
  const results: LegacySkillMigrationResult[] = [];
  const roots = knownInstallRoots(options);
  for (const [legacyName, newName] of LEGACY_SKILL_RENAMES) {
    const newBundled = resolveBundledSkillPath({ ...options, skillName: newName });
    if (!fs.existsSync(path.join(newBundled, "SKILL.md"))) continue;
    const stub = resolveBundledSkillPath({ ...options, skillName: legacyName });
    const known = new Set<string>([LEGACY_BUNDLED_SKILL_DIGEST]);
    if (fs.existsSync(path.join(stub, "SKILL.md"))) known.add(digestDirectory(stub));
    const linkSource = options.linkSourceFor?.(newName) ?? newBundled;
    // Every old location, primary or duplicate, moves to the new name in that
    // harness's primary location, so an install that only exists in a
    // harness's own folder keeps working after the rename.
    const locations = new Map<string, string>();
    for (const harness of SUPPORTED_HARNESSES) {
      const newPath = path.resolve(resolvePrimarySkillTargetPath(harness, { ...options, skillName: newName }));
      const legacyPaths = [
        resolvePrimarySkillTargetPath(harness, { ...options, skillName: legacyName }),
        ...resolveDuplicateSkillTargetPaths(harness, { ...options, skillName: legacyName })
      ];
      for (const legacyPath of legacyPaths) {
        const key = path.resolve(legacyPath);
        if (!locations.has(key)) locations.set(key, newPath);
      }
    }
    for (const [legacyPath, newPath] of locations) {
      const result = migrateLegacySkillPath({ legacyPath, newPath, legacyName, newName, known, newBundled, linkSource, roots, options });
      if (result) results.push(result);
    }
  }
  return results;
}

function migrateLegacySkillPath(input: {
  legacyPath: string; newPath: string; legacyName: string; newName: string; known: Set<string>;
  newBundled: string; linkSource: string; roots: string[]; options: LegacySkillMigrationOptions;
}): LegacySkillMigrationResult | null {
  const { legacyPath, newPath, legacyName, newName, options } = input;
  let legacy: fs.Stats | undefined;
  try {
    legacy = fs.lstatSync(legacyPath, { throwIfNoEntry: false });
  } catch (error) {
    return { legacyPath, newPath, status: "failed", message: errorText(error) };
  }
  if (!legacy) return null;
  const kept = (status: "kept_customized" | "kept_occupied", message: string): LegacySkillMigrationResult => ({
    legacyPath, newPath, status, message, offer: keptOffer(legacyPath, `${status}-${newName}`, options)
  });
  try {
    const recorded = getManagedContent(legacyPath, options)?.digest;
    if (!legacyIsOurs(legacyPath, legacy, legacyName, input.known, recorded, input.roots)) {
      return kept("kept_customized", `${legacyPath} is customized or not from shrooms; left in place. The skill is now ${newName}.`);
    }
    const state = newSkillState(newPath, input.newBundled, input.linkSource, options);
    if (state === "occupied") {
      return kept("kept_occupied", `${newPath} already holds something else; left ${legacyPath} in place.`);
    }
    if (state === "absent" && !createNewSkill(newPath, legacy.isSymbolicLink(), input.newBundled, input.linkSource, options)) {
      return kept("kept_occupied", `${newPath} appeared while moving ${legacyPath}; left the old install in place.`);
    }
    removeInstalledSkill(legacyPath);
    return { legacyPath, newPath, status: "renamed", message: `Moved skill ${legacyPath} to ${newPath}.` };
  } catch (error) {
    return { legacyPath, newPath, status: "failed", message: errorText(error) };
  }
}

/**
 * Whether an old install is shrooms' own and unedited. A link must lead to a
 * known install location or have been recorded when shrooms made it; then its
 * content must be the stub, an old bundled skill, or what was recorded. A
 * dangling link counts only with that evidence. A copy must match its record.
 */
function legacyIsOurs(
  legacyPath: string, stat: fs.Stats, legacyName: string, known: Set<string>, recorded: string | undefined, roots: string[]
): boolean {
  if (stat.isSymbolicLink()) {
    const destination = path.resolve(path.dirname(legacyPath), fs.readlinkSync(legacyPath));
    if (!isShroomsSkillLocation(destination, legacyName, roots) && recorded === undefined) return false;
    if (!fs.existsSync(destination)) return true;
    if (!fs.statSync(destination).isDirectory()) return false;
    const digest = digestDirectory(destination);
    return known.has(digest) || digest === recorded;
  }
  if (!stat.isDirectory()) return false;
  const digest = digestDirectory(legacyPath);
  return digest === recorded || digest === LEGACY_BUNDLED_SKILL_DIGEST;
}

/**
 * Install directories shrooms itself manages: this package, the standalone
 * install directory (its `current` link and releases), the default install
 * directory, and the published npm package. Nothing else counts by location.
 */
function knownInstallRoots(options: SkillInstallOptions): string[] {
  const roots = [currentPackageDir()];
  const homeDir = options.homeDir ?? process.env.HOME ?? "";
  const installDirs = [path.join(homeDir, ".local", "share", "talking-stick")];
  if (isStandalone()) installDirs.push(standaloneInstallDir());
  for (const installDir of installDirs) {
    roots.push(path.join(installDir, "current"));
    roots.push(path.join(installDir, "releases"));
  }
  return roots;
}

function isShroomsSkillLocation(destination: string, skillName: string, roots: string[]): boolean {
  if (path.basename(destination) !== skillName || path.basename(path.dirname(destination)) !== "skills") return false;
  const packageRoot = path.dirname(path.dirname(destination));
  if (/[\\/]node_modules[\\/]talking-stick$/.test(packageRoot)) return true;
  return roots.some((root) => {
    if (path.basename(root) === "releases") return path.dirname(path.resolve(packageRoot)) === path.resolve(root);
    return path.resolve(packageRoot) === path.resolve(root) || sameRealPath(packageRoot, root);
  });
}

function newSkillState(
  newPath: string, newBundled: string, linkSource: string, options: SkillInstallOptions
): "absent" | "ours" | "occupied" {
  const stat = fs.lstatSync(newPath, { throwIfNoEntry: false });
  if (!stat) return "absent";
  if (stat.isSymbolicLink()) {
    const destination = path.resolve(path.dirname(newPath), fs.readlinkSync(newPath));
    // Anything else there, even an old link of ours, is left for the person to sort out.
    return sameRealPath(destination, linkSource) || sameRealPath(destination, newBundled) ? "ours" : "occupied";
  }
  if (stat.isDirectory()) {
    const digest = digestDirectory(newPath);
    return digest === digestDirectory(newBundled) || digest === getManagedContent(newPath, options)?.digest ? "ours" : "occupied";
  }
  return "occupied";
}

/**
 * Creates the new skill only where nothing exists yet. A link is made in
 * place, and a copy first reserves its directory with an exclusive mkdir; both
 * fail if anything appeared at the path since the check. Returns false then.
 */
function createNewSkill(
  newPath: string, asLink: boolean, newBundled: string, linkSource: string, options: SkillInstallOptions
): boolean {
  fs.mkdirSync(path.dirname(newPath), { recursive: true });
  try {
    if (asLink) {
      fs.symlinkSync(linkSource, newPath, process.platform === "win32" ? "junction" : "dir");
    } else {
      fs.mkdirSync(newPath);
      fs.cpSync(newBundled, newPath, { recursive: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  recordManagedContent(newPath, "skill-copy", digestDirectory(asLink ? linkSource : newBundled), options);
  return true;
}

function keptOffer(legacyPath: string, reason: string, options: SkillInstallOptions): boolean {
  return options.markOffers === false ? true : recordManagedContentOffer(legacyPath, reason, "skill-copy", options);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

    // A duplicate is the only copy a harness has until its own location holds
    // the skill, so it stays when that install was skipped, refused, or failed.
    const primaryPath = resolvePrimarySkillTargetPath(harness, options);
    const primary = { path: primaryPath, holdsSkill: holdsBundledSkill(primaryPath, sourcePath, options) };
    for (const targetPath of targets) {
      const result = cleanupDuplicateSkillTarget(harness, targetPath, sourcePath, primary);
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

/** Whether a location holds this skill: a link to it, or a copy of it or of what was recorded there. */
function holdsBundledSkill(targetPath: string, sourcePath: string, options: SkillInstallOptions): boolean {
  try {
    const stat = fs.lstatSync(targetPath, { throwIfNoEntry: false });
    if (!stat) return false;
    if (stat.isSymbolicLink()) return fs.realpathSync(targetPath) === fs.realpathSync(sourcePath);
    if (!stat.isDirectory()) return false;
    const digest = digestDirectory(targetPath);
    return digest === digestDirectory(sourcePath) || digest === getManagedContent(targetPath, options)?.digest;
  } catch {
    return false;
  }
}

function cleanupDuplicateSkillTarget(
  harness: HarnessId,
  targetPath: string,
  sourcePath: string,
  primary: { path: string; holdsSkill: boolean }
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

    if (!primary.holdsSkill) {
      return {
        harness,
        action: "preserved",
        message: `${targetPath} left in place: ${primary.path} does not hold the skill yet.`,
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

function dedupeSyncTargets(options: SkillInstallOptions): HarnessId[] {
  const seen = new Set<string>();
  const targets: HarnessId[] = [];
  for (const harness of SUPPORTED_HARNESSES) {
    const targetPath = resolvePrimarySkillTargetPath(harness, options);
    const key = path.resolve(targetPath);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(harness);
  }
  return targets;
}

function currentPackageDir(): string {
  if (isStandalone()) return standaloneLinkRoot();
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
  harness: HarnessId,
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
    // A companion skill appears beside an existing default install, so an
    // update brings it without another tt install.
    const defaultTarget = path.join(path.dirname(targetPath), DEFAULT_SKILL_NAME);
    if (options.installBesideDefault && fs.existsSync(harnessRootPath) && !fs.existsSync(targetPath) &&
        fs.lstatSync(targetPath, { throwIfNoEntry: false }) === undefined && fs.existsSync(defaultTarget)) {
      installSkillDirectory(sourcePath, targetPath, undefined, fs.lstatSync(defaultTarget).isSymbolicLink(), options);
      return { harness, targetPath, status: "updated", message: `installed beside ${DEFAULT_SKILL_NAME}` };
    }
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
  harness: HarnessId,
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
