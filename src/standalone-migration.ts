import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SUPPORTED_HARNESSES } from "./harness-model.js";
import { digestDirectory, getManagedContent, recordManagedContent } from "./managed-content.js";
import { detectInstallSource } from "./self-update.js";
import { BUNDLED_SKILL_NAMES, LEGACY_SKILL_NAMES, resolveDuplicateSkillTargetPaths, resolvePrimarySkillTargetPath } from "./skill-install.js";
import { standaloneInstallDir, standaloneRoot } from "./standalone-mode.js";

// Moving a machine from the npm package to the standalone binary. Everything
// here is conservative: it only touches skill links it can prove Talking Stick
// created, and it only proposes removing an npm copy it can prove is the
// published package (never an `npm link` of a development checkout).

export interface MigrationOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  /** The running release directory; defaults to the binary's own. */
  releaseRoot?: string;
}

/** Installs a relative alias so it follows the installer's next tt link. */
export function installRoomsAlias(binDir: string): boolean {
  const alias = path.join(binDir, "rooms");
  try {
    fs.symlinkSync("tt", alias);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  try {
    return fs.readlinkSync(alias) === "tt";
  } catch {
    return false;
  }
}

export interface RepointedLink {
  path: string;
  from: string;
  to: string;
}

export interface RepointResult {
  repointed: RepointedLink[];
  /** Links that look managed but whose content or origin cannot be proven; left untouched. */
  unproven: RepointedLink[];
}

/**
 * Points <install-dir>/current at this release when it is missing or broken.
 * The 0.23.0 installer predates `current`, so a binary it installed creates
 * the link itself on first use.
 */
export function ensureCurrentLink(options: MigrationOptions = {}, force = false): boolean {
  const releaseRoot = options.releaseRoot ?? standaloneRoot();
  const current = path.join(standaloneInstallDir(releaseRoot), "current");
  if (!force && fs.existsSync(path.join(current, "package.json"))) return false;
  const temporary = `${current}.${process.pid}.tmp`;
  fs.rmSync(temporary, { force: true });
  fs.symlinkSync(path.join("releases", path.basename(releaseRoot)), temporary, "dir");
  fs.rmSync(current, { force: true });
  fs.renameSync(temporary, current);
  return true;
}

/**
 * Moves <install-dir>/current to this release. A skill linked through
 * `current` whose content was edited since Talking Stick linked it is first
 * pinned to the release it resolves to now, so advancing `current` never
 * swaps out someone's edits. Returns the pinned links.
 */
export function advanceCurrentLink(options: MigrationOptions = {}): RepointedLink[] {
  const releaseRoot = options.releaseRoot ?? standaloneRoot();
  const env = options.env ?? process.env;
  const pinned: RepointedLink[] = [];
  // Old skill names too: a release before 0.39 serves its skills under them.
  for (const skillName of ALL_SKILL_NAMES) {
    const currentSkill = path.join(standaloneInstallDir(releaseRoot), "current", "skills", skillName);
    const currentResolved = safeRealpath(currentSkill);
    if (!currentResolved) continue;
    for (const target of skillLinkTargets(options, [skillName])) {
      const from = linkDestination(target);
      // Any route into the skill `current` serves today, aliases included.
      if (from === null || safeRealpath(target) !== currentResolved) continue;
      const recorded = getManagedContent(target, { env })?.digest;
      if (recorded && digestDirectory(currentResolved) === recorded) continue;
      replaceLink(target, currentResolved);
      pinned.push({ path: target, from, to: currentResolved });
    }
  }
  ensureCurrentLink(options, true);
  return pinned;
}

const ALL_SKILL_NAMES: readonly string[] = [...BUNDLED_SKILL_NAMES, ...LEGACY_SKILL_NAMES];

/** Skill install locations that are symlinks resolving into `packageDir`. */
export function skillLinksInto(packageDir: string, options: MigrationOptions = {}): string[] {
  const root = safeRealpath(packageDir);
  if (!root) return [];
  return skillLinkTargets(options, ALL_SKILL_NAMES).filter((target) => {
    if (linkDestination(target) === null) return false;
    const resolved = safeRealpath(target);
    return resolved !== null && (resolved === root || resolved.startsWith(root + path.sep));
  });
}

function skillLinkTargets(options: MigrationOptions, skillNames: readonly string[]): string[] {
  const env = options.env ?? process.env;
  return [...new Set(skillNames.flatMap((skillName) => {
    const installOptions = { homeDir: options.homeDir ?? env.HOME, env, skillName };
    return SUPPORTED_HARNESSES.flatMap((harness) => [
      resolvePrimarySkillTargetPath(harness, installOptions),
      ...resolveDuplicateSkillTargetPaths(harness, installOptions)
    ]);
  }).map((target) => path.resolve(target)))];
}

function linkDestination(target: string): string | null {
  try {
    if (!fs.lstatSync(target).isSymbolicLink()) return null;
    return path.resolve(path.dirname(target), fs.readlinkSync(target));
  } catch {
    return null;
  }
}

function replaceLink(target: string, destination: string): void {
  const temporary = `${target}.${process.pid}.tmp`;
  fs.rmSync(temporary, { force: true });
  fs.symlinkSync(destination, temporary, "dir");
  fs.renameSync(temporary, target);
}

/**
 * Re-points skill links that target a published npm copy or an older
 * standalone release at <install-dir>/current. A link moves only when its
 * resolved target is still such a copy and its content matches what Talking
 * Stick recorded when it made the link. Copies, customized skills, and links
 * into anything else (such as an `npm link`ed checkout) are left alone.
 */
export function repointManagedSkillLinks(options: MigrationOptions = {}): RepointResult {
  const releaseRoot = options.releaseRoot ?? standaloneRoot();
  const installDir = standaloneInstallDir(releaseRoot);
  const env = options.env ?? process.env;
  const repointed: RepointedLink[] = [];
  const unproven: RepointedLink[] = [];
  // Old names are moved by migrateLegacySkillInstalls, not re-pointed here.
  for (const skillName of BUNDLED_SKILL_NAMES) {
    const source = path.join(installDir, "current", "skills", skillName);
    if (!fs.existsSync(path.join(source, "SKILL.md"))) continue;
    for (const target of skillLinkTargets(options, [skillName])) {
      const from = linkDestination(target);
      if (from === null || from === source || !isManagedSkillSource(from, installDir, skillName)) continue;
      const resolved = safeRealpath(from);
      const recorded = getManagedContent(target, { env })?.digest;
      if (!resolved || !isManagedSkillSource(resolved, safeRealpath(installDir) ?? installDir, skillName) ||
          !recorded || digestDirectory(resolved) !== recorded) {
        unproven.push({ path: target, from, to: source });
        continue;
      }
      replaceLink(target, source);
      recordManagedContent(target, "skill-copy", digestDirectory(source), { env });
      repointed.push({ path: target, from, to: source });
    }
  }
  return { repointed, unproven };
}

function isManagedSkillSource(source: string, installDir: string, skillName: string): boolean {
  const normalized = source.split(path.sep).join("/");
  if (normalized.endsWith(`/node_modules/talking-stick/skills/${skillName}`) ||
      normalized.endsWith(`/node_modules/talking-stick/skills/${skillName}/`)) return true;
  const releases = path.join(installDir, "releases") + path.sep;
  return source.startsWith(releases) && source.endsWith(path.join("skills", skillName));
}

export interface NpmCopy {
  /** The `tt` on PATH that belongs to the npm package. */
  path: string;
  /** The package directory it runs from. */
  package_dir: string;
}

/**
 * Finds a `tt` on PATH, other than this installation's, that runs from the
 * globally installed npm package. Returns null unless `npm root -g` confirms
 * it, so pnpm/yarn/bun copies and `npm link` checkouts are only reported by
 * the installer, never removed.
 */
export function findRemovableNpmCopy(binDir: string, options: MigrationOptions = {}): NpmCopy | null {
  const env = options.env ?? process.env;
  const own = safeRealpath(path.join(binDir, "tt"));
  let npmRoot: string;
  try {
    npmRoot = execFileSync("npm", ["root", "-g"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
  const packageDir = path.join(npmRoot, "talking-stick");
  // `npm link` makes the global package a symlink to a checkout; leave those.
  try {
    if (fs.lstatSync(packageDir).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, "tt");
    const real = safeRealpath(candidate);
    if (!real || real === own) continue;
    if (detectInstallSource({ binaryPath: real, env }) !== "npm") continue;
    if (!real.startsWith(packageDir + path.sep)) continue;
    return { path: candidate, package_dir: packageDir };
  }
  return null;
}

function safeRealpath(file: string): string | null {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}
