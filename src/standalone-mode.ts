import fs from "node:fs";
import path from "node:path";

// Set by src/standalone.ts, the entry of the compiled `tt` binary. In that
// mode release assets (package.json, skills/, scripts/) sit beside the real
// executable rather than in an npm package directory.
let standalone = false;

export function markStandalone(): void {
  standalone = true;
}

export function isStandalone(): boolean {
  return standalone;
}

/** The release directory holding the real `tt` executable (symlinks resolved). */
export function standaloneRoot(): string {
  return path.dirname(fs.realpathSync(process.execPath));
}

/**
 * Whether a release directory sits where the installer puts it,
 * <install-dir>/releases/<release>. An archive extracted and run by hand does
 * not, and nothing may treat its ancestors as an install directory.
 */
export function isInstalledRelease(releaseRoot = standaloneRoot()): boolean {
  return path.basename(path.dirname(releaseRoot)) === "releases" &&
    fs.existsSync(path.join(releaseRoot, "package.json"));
}

/** An installer-managed release: the releases/ layout plus the receipt
 * scripts/install.sh writes. Only these can self-update or report an
 * installed update; a hand-extracted copy of the same layout cannot. */
export function isManagedRelease(releaseRoot = standaloneRoot(), platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32" && isInstalledRelease(releaseRoot) &&
    fs.existsSync(path.join(standaloneInstallDir(releaseRoot), "install-receipt"));
}

/** <install-dir> for a release at <install-dir>/releases/<release>. */
export function standaloneInstallDir(releaseRoot = standaloneRoot()): string {
  return path.dirname(path.dirname(releaseRoot));
}

/**
 * Where skill links should point: <install-dir>/current, which the installer
 * moves to each new release, so links survive updates. Falls back to the
 * release itself before `current` exists.
 */
export function standaloneLinkRoot(): string {
  if (!isInstalledRelease()) return standaloneRoot();
  const current = path.join(standaloneInstallDir(), "current");
  return fs.existsSync(path.join(current, "package.json")) ? current : standaloneRoot();
}
