import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { resolveDataDir } from "./config.js";
import { acquireLaunchLock } from "./launch-record.js";
import { writeFileAtomic } from "./atomic-write.js";

export interface ReleaseNotice { version: string; state: "available" | "installed" }
export interface ReleaseCache { checkedAt: number; nextCheckAt: number; latestVersion?: string }
export const RELEASE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const JITTER_MS = 6 * 60 * 60 * 1_000;
const STABLE = /^\d+\.\d+\.\d+$/;

export function newerRelease(candidate: string, current: string): boolean {
  if (!STABLE.test(candidate) || !STABLE.test(current)) return false;
  const a = candidate.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function cachePath(dataDir: string): string { return path.join(dataDir, "release-status.json"); }

export function readReleaseCache(dataDir = resolveDataDir()): ReleaseCache | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(cachePath(dataDir), "utf8")) as ReleaseCache;
    if (!Number.isFinite(value.checkedAt) || !Number.isFinite(value.nextCheckAt) ||
        value.nextCheckAt < value.checkedAt + RELEASE_CHECK_INTERVAL_MS ||
        value.nextCheckAt > value.checkedAt + RELEASE_CHECK_INTERVAL_MS + JITTER_MS ||
        (value.latestVersion !== undefined && (typeof value.latestVersion !== "string" || !STABLE.test(value.latestVersion)))) return;
    return value;
  } catch { return; }
}

export function releaseNotice(running: string, available?: string, installed?: string): ReleaseNotice | undefined {
  if (installed && newerRelease(installed, running)) return { version: installed, state: "installed" };
  if (available && newerRelease(available, running)) return { version: available, state: "available" };
  return;
}

/** Existing public release asset, delivered through GitHub's CDN, not its API. */
export function versionFromChecksums(text: string): string {
  const lines = text.trim().split(/\r?\n/);
  const versions = new Set<string>();
  for (const line of lines) {
    const match = /^[0-9a-f]{64}\s+\*?talking-stick_(\d+\.\d+\.\d+)_(?:darwin|linux|windows)_(?:arm64|x64)\.tar\.gz$/i.exec(line);
    if (!match) throw new Error("invalid release checksum manifest");
    versions.add(match[1]);
  }
  if (versions.size !== 1) throw new Error("inconsistent release checksum manifest");
  return [...versions][0];
}

async function fetchReleaseVersion(env: NodeJS.ProcessEnv): Promise<string> {
  const manifest = await new Promise<string>((resolve, reject) => {
    const child = execFile("curl", ["-fsSL", "--connect-timeout", "3", "--max-time", "5",
      "--max-filesize", "16384", "https://github.com/mostlydev/talking-stick/releases/latest/download/checksums.txt"],
    { env, encoding: "utf8", timeout: 6_000, maxBuffer: 16_384, windowsHide: true },
    (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin?.end();
  });
  return versionFromChecksums(manifest);
}

/** Shared by startup and open chats. Lock and re-read prevent per-pane polls.
 * Stamp before the request: crashes and offline failures also wait a full day.
 */
export async function checkRelease(options: {
  dataDir?: string; env?: NodeJS.ProcessEnv; now?: () => number;
  random?: () => number; fetchVersion?: () => Promise<string>;
} = {}): Promise<ReleaseCache | undefined> {
  const env = options.env ?? process.env;
  const dataDir = options.dataDir ?? resolveDataDir({ env });
  let cached = readReleaseCache(dataDir);
  if (env.TT_NO_AUTO_UPDATE === "1") return cached;
  const now = (options.now ?? Date.now)();
  // Backwards clock changes wait until the recorded deadline too.
  if (cached && now < cached.nextCheckAt) return cached;
  let unlock: (() => void) | undefined;
  try { unlock = acquireLaunchLock(dataDir, "release-status", { timeoutMs: 0 }); }
  catch { return cached; }
  try {
    cached = readReleaseCache(dataDir);
    if (cached && now < cached.nextCheckAt) return cached;
    const jitter = Math.floor(Math.max(0, Math.min(1, (options.random ?? Math.random)())) * JITTER_MS);
    const pending: ReleaseCache = { checkedAt: now, nextCheckAt: now + RELEASE_CHECK_INTERVAL_MS + jitter,
      ...(cached?.latestVersion ? { latestVersion: cached.latestVersion } : {}) };
    writeFileAtomic(cachePath(dataDir), JSON.stringify(pending));
    const latestVersion = await (options.fetchVersion ?? (() => fetchReleaseVersion(env)))();
    if (!STABLE.test(latestVersion)) throw new Error("invalid release version");
    // Never replace a newer verified notice with a stale CDN response.
    if (!pending.latestVersion || newerRelease(latestVersion, pending.latestVersion)) pending.latestVersion = latestVersion;
    writeFileAtomic(cachePath(dataDir), JSON.stringify(pending));
    return pending;
  } finally { unlock(); }
}
