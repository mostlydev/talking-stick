import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { checkRelease, readReleaseCache, releaseNotice, versionFromChecksums, RELEASE_CHECK_INTERVAL_MS } from "../src/release-status.js";
import { isManagedRelease } from "../src/standalone-mode.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const fixture = () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-release-check-"));
  roots.push(dataDir);
  return { dataDir, env: {}, now: () => 1_000_000_000, random: () => 0.5 };
};

test("all platform checksum entries must name one stable release", () => {
  const line = (version: string, platform = "darwin_arm64") => `${"a".repeat(64)}  talking-stick_${version}_${platform}.tar.gz`;
  expect(versionFromChecksums([line("0.31.0"), line("0.31.0", "windows_x64")].join("\n"))).toBe("0.31.0");
  for (const text of ["", "<html>offline</html>", line("0.31.0-rc.1"), `${line("0.31.0")}\n${line("0.30.0")}`, `${line("0.31.0")}\nuntrusted`]) {
    expect(() => versionFromChecksums(text)).toThrow();
  }
});

test("a shared cached check waits 24h plus jitter across clients, including backwards clock changes", async () => {
  const options = fixture();
  const fetchVersion = vi.fn(async () => "0.31.0");
  const first = await checkRelease({ ...options, fetchVersion });
  expect(first?.nextCheckAt).toBe(options.now() + RELEASE_CHECK_INTERVAL_MS + 3 * 3_600_000);
  for (const now of [options.now(), options.now() - 1_000, options.now() + RELEASE_CHECK_INTERVAL_MS]) {
    await checkRelease({ ...options, fetchVersion, now: () => now });
  }
  expect(fetchVersion).toHaveBeenCalledTimes(1);
  await checkRelease({ ...options, fetchVersion, now: () => first!.nextCheckAt });
  expect(fetchVersion).toHaveBeenCalledTimes(2);
});

test("simultaneous panes make one request and failed attempts keep their deadline", async () => {
  const options = fixture();
  let finish!: (version: string) => void;
  const fetchVersion = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
  const first = checkRelease({ ...options, fetchVersion });
  await checkRelease({ ...options, fetchVersion });
  expect(fetchVersion).toHaveBeenCalledTimes(1);
  finish("0.31.0"); await first;
  const next = readReleaseCache(options.dataDir)!.nextCheckAt;
  const fail = vi.fn(async () => { throw new Error("rate limited"); });
  const expired = { ...options, now: () => next, fetchVersion: fail };
  await expect(checkRelease(expired)).rejects.toThrow("rate limited");
  expect(readReleaseCache(options.dataDir)?.latestVersion).toBe("0.31.0");
  await checkRelease(expired);
  expect(fail).toHaveBeenCalledTimes(1);
});

test("a stale CDN result cannot downgrade a notice and opting out never calls the network", async () => {
  const options = fixture();
  const first = await checkRelease({ ...options, fetchVersion: async () => "0.31.0" });
  const second = await checkRelease({ ...options, now: () => first!.nextCheckAt, fetchVersion: async () => "0.30.0" });
  expect(second?.latestVersion).toBe("0.31.0");
  const fetchVersion = vi.fn();
  await checkRelease({ ...options, env: { TT_NO_AUTO_UPDATE: "1" }, now: () => second!.nextCheckAt, fetchVersion });
  expect(fetchVersion).not.toHaveBeenCalled();
});

test("only a newer installed version produces restart advice", () => {
  expect(releaseNotice("0.30.0", "0.31.0")).toEqual({ version: "0.31.0", state: "available" });
  expect(releaseNotice("0.30.0", "0.32.0", "0.31.0")).toEqual({ version: "0.31.0", state: "installed" });
  expect(releaseNotice("0.31.0", "0.31.0", "0.31.0")).toBeUndefined();
  expect(releaseNotice("0.31.0-rc.1", "0.32.0")).toBeUndefined();
});

test("only an installer receipt makes a releases/ layout managed", () => {
  const install = fs.mkdtempSync(path.join(os.tmpdir(), "tt-release-layout-"));
  roots.push(install);
  const release = path.join(install, "releases", "0.30.0");
  fs.mkdirSync(release, { recursive: true });
  fs.writeFileSync(path.join(release, "package.json"), JSON.stringify({ version: "0.30.0" }));
  // A hand-extracted copy of the same layout cannot self-update.
  expect(isManagedRelease(release, "darwin")).toBe(false);
  fs.writeFileSync(path.join(install, "install-receipt"), "bin_dir=/tmp/bin\n");
  expect(isManagedRelease(release, "darwin")).toBe(true);
  expect(isManagedRelease(release, "win32")).toBe(false);
  expect(isManagedRelease(path.join(install, "loose"), "darwin")).toBe(false);
});
