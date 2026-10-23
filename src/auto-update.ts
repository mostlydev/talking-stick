import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { checkRelease, newerRelease } from "./release-status.js";
export { newerRelease } from "./release-status.js";
import { acquireLaunchLock } from "./launch-record.js";
import { writeFileAtomic } from "./atomic-write.js";
import { planStandaloneUpdate } from "./self-update.js";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/** The explicit updater and startup updater serialize against the same install. */
export function acquireUpdateLock(releaseRoot: string): () => void {
  const installDir = path.dirname(path.dirname(releaseRoot));
  try {
    return acquireLaunchLock(path.join(installDir, ".updates"), "self-update", { timeoutMs: 0 });
  } catch (error) {
    throw new Error("Another tt update may be running; try again after it finishes.", { cause: error });
  }
}

export interface AutoUpdateOptions {
  releaseRoot: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  latestVersion?: () => Promise<string>;
  install?: (version: string) => Promise<void>;
  report?: (message: string) => void;
}

function readVersion(root: string): string {
  return (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }).version;
}

/** Returns true when the caller must stop and ask for a restart before opening the DB. */
export async function autoUpdate(options: AutoUpdateOptions): Promise<boolean> {
  const env = options.env ?? process.env;
  if (env.TT_NO_AUTO_UPDATE === "1") return false;
  const root = options.releaseRoot;
  const installDir = path.dirname(path.dirname(root));
  // A downloaded archive, source checkout, or npm-linked checkout is never managed here.
  if (path.basename(path.dirname(root)) !== "releases" ||
      !fs.existsSync(path.join(installDir, "install-receipt"))) return false;
  const report = options.report ?? ((message: string) => process.stderr.write(`${message}\n`));
  let release: (() => void) | undefined;
  try {
    release = acquireUpdateLock(root);
  } catch {
    // Another invocation owns the check/install. Continue using the existing release.
    return false;
  }
  try {
    const current = readVersion(root);
    const active = readVersion(path.join(installDir, "current"));
    if (newerRelease(active, current)) {
      report(`Talking Stick ${active} is installed. Restart this command to load it.`);
      return true;
    }
    // Never repoint an installation from a manually launched historical release.
    if (fs.realpathSync(path.join(installDir, "current")) !== fs.realpathSync(root)) return false;
    const stamp = path.join(installDir, ".updates", "last-check.json");
    const now = (options.now ?? Date.now)();
    try {
      const previous = JSON.parse(fs.readFileSync(stamp, "utf8")) as { checkedAt: number };
      if (Number.isFinite(previous.checkedAt) && now >= previous.checkedAt && now - previous.checkedAt < CHECK_INTERVAL_MS) return false;
    } catch { /* Missing or invalid cache: check again. */ }
    // Cache failed attempts too, so offline startups do not repeatedly wait for the network.
    writeFileAtomic(stamp, JSON.stringify({ checkedAt: now }));
    const latest = await (options.latestVersion ?? (() => fetchLatestVersion(env)))();
    if (!newerRelease(latest, current)) return false;
    report(`Talking Stick ${latest} is available; updating…`);
    await (options.install ?? ((version) => installRelease(root, version, env)))(latest);
    const installed = readVersion(path.join(installDir, "current"));
    if (installed !== latest) throw new Error(`installer left version ${installed} active instead of ${latest}`);
    report(`Talking Stick ${installed} installed. Restart this command and any running chats or harnesses to load it.`);
    return true;
  } catch (error) {
    report(`Talking Stick auto-update failed: ${summarizeError(error)}. Continuing; run tt self-update to retry.`);
    // A post-install step can fail after the binary link has already advanced.
    // Do not dispatch the old command into a newly migrated database.
    try {
      const active = readVersion(path.join(installDir, "current"));
      if (newerRelease(active, readVersion(root))) {
        report(`Talking Stick ${active} is installed. Restart this command to load it.`);
        return true;
      }
    } catch { /* The original failure is already reported. */ }
    return false;
  } finally {
    release();
  }
}

// execFile errors embed the installer's captured output; keep only its first line.
function summarizeError(error: unknown): string {
  const line = (error instanceof Error ? error.message : String(error)).split("\n", 1)[0].trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

async function fetchLatestVersion(env: NodeJS.ProcessEnv): Promise<string> {
  const cached = await checkRelease({ env });
  if (!cached?.latestVersion) throw new Error("release version unavailable");
  return cached.latestVersion;
}

async function installRelease(root: string, version: string, env: NodeJS.ProcessEnv): Promise<void> {
  const plan = planStandaloneUpdate(root);
  await new Promise<void>((resolve, reject) => {
    const child = execFile(plan.command, [...plan.args, "--version", version, "--no-remove-npm"], {
      env: { ...env, TT_NO_AUTO_UPDATE: "1", TALKING_STICK_RELEASE_BASE_URL: "" }, timeout: 120_000,
      maxBuffer: 1024 * 1024
    }, (error) => error ? reject(error) : resolve());
    child.stdin?.end();
  });
}
