import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { acquireUpdateLock, autoUpdate, newerRelease } from "../src/auto-update.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); vi.unstubAllGlobals(); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-update-test-"));
  roots.push(dir);
  const root = path.join(dir, "releases", "0.24.1-hash");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.24.1" }));
  fs.writeFileSync(path.join(dir, "install-receipt"), "bin_dir=/unused\n");
  fs.symlinkSync(root, path.join(dir, "current"));
  const latestVersion = vi.fn(async () => "0.25.0");
  const install = vi.fn(async (version: string) => {
    const next = path.join(dir, "releases", version);
    fs.mkdirSync(next);
    fs.writeFileSync(path.join(next, "package.json"), JSON.stringify({ version }));
    fs.unlinkSync(path.join(dir, "current"));
    fs.symlinkSync(next, path.join(dir, "current"));
  });
  const report = vi.fn();
  return { dir, root, options: { releaseRoot: root, env: {}, latestVersion, install, report, now: () => 1_000_000_000 } };
}

describe("automatic standalone updates", () => {
  test("compares stable versions numerically without downgrading prereleases", () => {
    expect(newerRelease("0.25.0", "0.24.9")).toBe(true);
    expect(newerRelease("0.9.0", "0.24.1")).toBe(false);
    expect(newerRelease("0.24.1", "0.24.1")).toBe(false);
    expect(newerRelease("0.25.0", "0.25.0-rc.1")).toBe(false);
    expect(newerRelease("malformed", "0.24.1")).toBe(false);
  });
  test("installs once, retains the old release/data, and requests restart", async () => {
    const { dir, root, options } = fixture();
    fs.writeFileSync(path.join(dir, "sentinel"), "keep");
    expect(await autoUpdate(options)).toBe(true);
    expect(options.install).toHaveBeenCalledExactlyOnceWith("0.25.0");
    expect(options.report.mock.calls.at(-1)?.[0]).toMatch(/0.25.0 installed.*Restart/);
    expect(fs.existsSync(path.join(root, "package.json"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "sentinel"), "utf8")).toBe("keep");
    // An old process must not reinstall or open a DB after another process upgraded.
    expect(await autoUpdate(options)).toBe(true);
    expect(options.install).toHaveBeenCalledTimes(1);
  });
  test("current releases cache checks for a day and retry after expiry", async () => {
    const { options } = fixture();
    options.latestVersion.mockResolvedValue("0.24.1");
    expect(await autoUpdate(options)).toBe(false);
    expect(await autoUpdate(options)).toBe(false);
    expect(options.latestVersion).toHaveBeenCalledTimes(1);
    expect(await autoUpdate({ ...options, now: () => 1_000_000_000 + 86_400_000 })).toBe(false);
    expect(options.latestVersion).toHaveBeenCalledTimes(2);
    expect(options.install).not.toHaveBeenCalled();
  });
  test("offline failure is actionable, cached, and leaves the active release usable", async () => {
    const { dir, root, options } = fixture();
    options.latestVersion.mockRejectedValue(new Error("offline"));
    expect(await autoUpdate(options)).toBe(false);
    expect(await autoUpdate(options)).toBe(false);
    expect(options.latestVersion).toHaveBeenCalledTimes(1);
    expect(options.report).toHaveBeenCalledWith(expect.stringMatching(/offline.*Continuing.*self-update/));
    expect(fs.realpathSync(path.join(dir, "current"))).toBe(fs.realpathSync(root));
  });
  test("failed installation leaves the command usable; a false success is detected", async () => {
    const { options } = fixture();
    options.install.mockRejectedValueOnce(new Error(`checksum mismatch\n${"installer output ".repeat(40)}`));
    expect(await autoUpdate(options)).toBe(false);
    expect(options.report).toHaveBeenLastCalledWith(expect.stringContaining("checksum mismatch"));
    // Captured installer output stays out of the one-line notice.
    expect(options.report.mock.lastCall![0]).not.toContain("installer output");
    options.install.mockResolvedValue(undefined);
    expect(await autoUpdate({ ...options, now: () => 1_100_000_000 })).toBe(false);
    expect(options.report).toHaveBeenLastCalledWith(expect.stringContaining("instead of 0.25.0"));
  });
  test("concurrent invocation and manual update cannot compete with an in-flight install", async () => {
    const { options } = fixture();
    let finish!: () => void;
    const barrier = new Promise<void>((resolve) => { finish = resolve; });
    const install = options.install.getMockImplementation()!;
    options.install.mockImplementation(async (v) => { await barrier; await install(v); });
    const first = autoUpdate(options);
    await vi.waitFor(() => expect(options.install).toHaveBeenCalledTimes(1));
    expect(await autoUpdate(options)).toBe(false);
    expect(() => acquireUpdateLock(options.releaseRoot)).toThrow(/Another tt update/);
    finish();
    expect(await first).toBe(true);
    const release = acquireUpdateLock(options.releaseRoot);
    release();
  });
  test("skips opt-out, source and unregistered standalone copies without network or writes", async () => {
    const { dir, options } = fixture();
    expect(await autoUpdate({ ...options, env: { TT_NO_AUTO_UPDATE: "1" } })).toBe(false);
    const checkout = path.join(dir, "checkout");
    fs.mkdirSync(checkout);
    expect(await autoUpdate({ ...options, releaseRoot: checkout })).toBe(false);
    fs.unlinkSync(path.join(dir, "install-receipt"));
    expect(await autoUpdate(options)).toBe(false);
    expect(options.latestVersion).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, ".updates"))).toBe(false);
  });
  test.each(["v0.25.0", "bad-tag"])("the bounded curl check closes stdin and validates %s", async (tag) => {
    const { dir, options } = fixture();
    const bin = path.join(dir, "fake-bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "curl"), `#!/bin/sh
printf '%s\\n' "$@" > "$TT_TEST_ARGS"
cat >/dev/null
printf '${"a".repeat(64)}  talking-stick_${tag.slice(1)}_darwin_arm64.tar.gz\\n'
`, { mode: 0o755 });
    expect(await autoUpdate({ ...options, env: { TALKING_STICK_DATA_DIR: path.join(dir, "data"), PATH: `${bin}${path.delimiter}${process.env.PATH}`, TT_TEST_ARGS: path.join(dir, "curl-args") }, latestVersion: undefined })).toBe(tag === "v0.25.0");
    const args = fs.readFileSync(path.join(dir, "curl-args"), "utf8");
    expect(args).toContain("--connect-timeout\n3\n--max-time\n5");
    expect(args).toContain("https://github.com/mostlydev/talking-stick/releases/latest/download/checksums.txt");
    expect(args).not.toContain("api.github.com");
    if (tag === "bad-tag") expect(options.install).not.toHaveBeenCalled();
  });
  test("the real installer subprocess is pinned, noninteractive and keeps its output off stdout", async () => {
    const { dir, root, options } = fixture();
    fs.mkdirSync(path.join(root, "scripts"));
    fs.writeFileSync(path.join(root, "scripts", "install.sh"), `#!/bin/sh
set -eu
printf '%s\\n' "$@" > "$TT_TEST_UPDATE_DIR/arguments"
[ "$TT_NO_AUTO_UPDATE" = 1 ]
[ -z "$TALKING_STICK_RELEASE_BASE_URL" ]
mkdir "$TT_TEST_UPDATE_DIR/releases/0.25.0"
printf '{"version":"0.25.0"}' > "$TT_TEST_UPDATE_DIR/releases/0.25.0/package.json"
ln -s "$TT_TEST_UPDATE_DIR/releases/0.25.0" "$TT_TEST_UPDATE_DIR/next"
rm "$TT_TEST_UPDATE_DIR/current"
mv "$TT_TEST_UPDATE_DIR/next" "$TT_TEST_UPDATE_DIR/current"
echo installer-stdout
echo installer-stderr >&2
`);
    const output = vi.spyOn(process.stdout, "write");
    try {
      expect(await autoUpdate({ ...options, env: { ...process.env, TT_NO_AUTO_UPDATE: "", TT_TEST_UPDATE_DIR: dir, TALKING_STICK_RELEASE_BASE_URL: "/bad-mirror" }, install: undefined })).toBe(true);
      expect(fs.readFileSync(path.join(dir, "arguments"), "utf8")).toContain("--version\n0.25.0\n--no-remove-npm");
      expect(output).not.toHaveBeenCalled();
    } finally { output.mockRestore(); }
  });
});
