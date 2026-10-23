import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { digestDirectory, recordManagedContent } from "../src/managed-content.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Builds the real `bun build --compile` binary, installs it with
// scripts/install.sh, and drives a full turn through it. Skipped where Bun
// is not installed; the release workflow always has it.
const hasBun = spawnSync("bun", ["--version"]).status === 0;
const supported = (process.platform === "darwin" || process.platform === "linux") &&
  (process.arch === "x64" || process.arch === "arm64");

describe.skipIf(!hasBun || !supported)("standalone binary", () => {
  let root = "";
  let bin = "";
  let install = "";
  let tt = "";
  // An isolated HOME keeps startup maintenance away from real skill and
  // instruction installs.
  const env = () => ({ ...process.env, HOME: path.join(root, "home"), TALKING_STICK_DATA_DIR: path.join(root, "data"),
    TT_ROOM: "", XDG_CONFIG_HOME: path.join(root, "home", ".config"),
    TT_HARNESS_AGENT_ID: "claude:standalone", TALKING_STICK_DISABLE_SKILL_SYNC: "1", TALKING_STICK_DISABLE_SKILLER: "1" });
  const run = (args: string[], cwd: string) =>
    JSON.parse(execFileSync(tt, [...args, "--json"], { cwd, env: env(), encoding: "utf8" }));

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-standalone-"));
    const assets = path.join(root, "assets");
    execFileSync("node", ["scripts/build-standalone.mjs", `bun-${process.platform}-${process.arch}`],
      { env: { ...process.env, TT_RELEASE_DIR: assets }, stdio: "pipe" });
    const sums = fs.readdirSync(assets).filter((name) => name.endsWith(".sha256"))
      .map((name) => fs.readFileSync(path.join(assets, name), "utf8")).join("");
    fs.writeFileSync(path.join(assets, "checksums.txt"), sums);
    // The installer's post-install step runs under this HOME and may create it.
    fs.mkdirSync(path.join(root, "home"), { recursive: true });
    bin = path.join(root, "bin dir");
    install = path.join(root, "install dir");
    execFileSync("sh", ["scripts/install.sh", "--base-url", assets, "--bin-dir", bin, "--install-dir", install],
      { env: env(), stdio: "pipe" });
    tt = path.join(bin, "tt");
  }, 180_000);
  afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it("joins, takes the turn through its own guardian, messages, and releases", () => {
    const project = path.join(root, "project");
    fs.mkdirSync(project);
    execFileSync("git", ["init", "-q", project]);
    expect(run(["join"], project).room_id).toBeTruthy();
    const turn = run(["wait", "--claim", "--timeout", "5"], project);
    expect(turn.status).toBe("your_turn");
    expect(turn.guardian_pid).toBeGreaterThan(0);
    expect(run(["msg", "send", "room", "from the binary"], project).event_seq).toBeGreaterThan(0);
    expect(run(["release", "--status", "done", "--next-action", "none"], project).status).toBe("released");
    expect(run(["state"], project).room.owner).toBeNull();
    const nodeState = JSON.parse(execFileSync(process.execPath, [path.resolve("dist/cli.js"), "state", "--json"],
      { cwd: project, env: env(), encoding: "utf8" }));
    expect(nodeState.room.room_id).toBe(run(["state"], project).room.room_id);
    execFileSync(process.execPath, [path.resolve("dist/cli.js"), "notes", "add", "from Node", "--json"],
      { cwd: project, env: env(), encoding: "utf8" });
    expect(JSON.stringify(run(["notes", "list"], project))).toContain("from Node");
  });

  it("recreates a missing current link, as after an upgrade by the 0.23.0 installer", () => {
    const current = path.join(install, "current");
    expect(fs.realpathSync(path.join(current, "tt"))).toBe(fs.realpathSync(tt));
    fs.rmSync(current);
    // Any maintained command heals the link, even one that then fails here.
    spawnSync(tt, ["state", "--json"], { cwd: root, env: env() });
    expect(fs.realpathSync(path.join(current, "tt"))).toBe(fs.realpathSync(tt));
  });

  it("checks updates through curl only in a human terminal, with JSON remaining side-effect free", () => {
    const fakeBin = path.join(root, "fake-curl");
    const called = path.join(root, "curl-called");
    const stamp = path.join(install, ".updates", "last-check.json");
    fs.mkdirSync(fakeBin);
    const version = (JSON.parse(fs.readFileSync("package.json", "utf8")) as { version: string }).version;
    fs.writeFileSync(path.join(fakeBin, "curl"), `#!/bin/sh
printf '%s\\n' "$@" > "$TT_TEST_CURL_CALLED"
cat >/dev/null
printf '${"a".repeat(64)}  talking-stick_${version}_darwin_arm64.tar.gz\\n'
`, { mode: 0o755 });
    const humanEnv = { ...env(), TT_NO_AUTO_UPDATE: "", PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, TT_TEST_CURL_CALLED: called };
    for (const key of Object.keys(humanEnv)) {
      if (/^(TT_HARNESS_|CODEX_|CLAUDE|CMUX_|GROK_|OPENCODE|ANTIGRAVITY|GEMINI_)/.test(key)) {
        delete (humanEnv as NodeJS.ProcessEnv)[key];
      }
    }
    fs.rmSync(stamp, { force: true });
    const json = execFileSync(tt, ["whoami", "--json"], { env: humanEnv, cwd: root, encoding: "utf8" });
    expect(() => JSON.parse(json)).not.toThrow();
    expect(fs.existsSync(stamp)).toBe(false);
    expect(fs.existsSync(called)).toBe(false);
    // Both systems provide script(1), with different ways to specify the child.
    const command = `'${tt.replaceAll("'", "'\\''")}' whoami`;
    const args = process.platform === "darwin" ? ["-q", "/dev/null", tt, "whoami"]
      : ["-q", "-e", "-c", command, "/dev/null"];
    const output = execFileSync("script", args, { env: humanEnv, cwd: root, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
    expect(output).not.toContain("auto-update failed");
    expect(fs.existsSync(stamp)).toBe(true);
    expect(fs.readFileSync(called, "utf8")).toContain("https://github.com/mostlydev/talking-stick/releases/latest/download/checksums.txt");
    const checkedAt = fs.readFileSync(stamp, "utf8");
    execFileSync("script", args, { env: humanEnv, cwd: root, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
    expect(fs.readFileSync(stamp, "utf8")).toBe(checkedAt);
  });

  it("writes nothing around an archive that was extracted and run by hand", () => {
    const extracted = path.join(root, "Downloads", "talking-stick");
    fs.mkdirSync(extracted, { recursive: true });
    const release = path.dirname(fs.realpathSync(tt));
    fs.cpSync(release, extracted, { recursive: true });
    spawnSync(path.join(extracted, "tt"), ["state", "--json"], { cwd: root, env: env() });
    expect(fs.existsSync(path.join(root, "current"))).toBe(false);
    expect(fs.existsSync(path.join(root, "Downloads", "current"))).toBe(false);
    const update = spawnSync(path.join(extracted, "tt"), ["self-update", "--print"], { env: env(), encoding: "utf8" });
    expect(update.status).not.toBe(0);
    expect(update.stderr).toContain("not installed by the installer");
  });

  it("migrates legacy skill links before explicit npm cleanup and blocks customized links", () => {
    const fakeRoot = fs.realpathSync(root);
    const npmRoot = path.join(fakeRoot, "npm", "lib", "node_modules");
    const npmPackage = path.join(npmRoot, "talking-stick");
    const npmSkill = path.join(npmPackage, "skills", "talking-stick");
    fs.mkdirSync(path.join(npmPackage, "dist"), { recursive: true });
    fs.writeFileSync(path.join(npmPackage, "dist", "cli.js"), "#!/bin/sh\necho fixture\n", { mode: 0o755 });
    fs.cpSync(path.join(path.dirname(fs.realpathSync(tt)), "skills", "talking-stick"), npmSkill, { recursive: true });
    const npmBin = path.join(fakeRoot, "npm", "bin");
    fs.mkdirSync(npmBin, { recursive: true });
    fs.symlinkSync(path.join(npmPackage, "dist", "cli.js"), path.join(npmBin, "tt"));
    const log = path.join(fakeRoot, "npm-actions");
    fs.writeFileSync(path.join(npmBin, "npm"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2).join(" ");
if (args === "root -g") console.log(${JSON.stringify(npmRoot)});
else if (args === "uninstall -g talking-stick") {
  fs.writeFileSync(${JSON.stringify(log)}, args);
  fs.rmSync(${JSON.stringify(npmPackage)}, {recursive: true, force: true});
  fs.unlinkSync(${JSON.stringify(path.join(npmBin, "tt"))});
} else process.exit(1);
`, { mode: 0o755 });
    const home = path.join(fakeRoot, "cleanup-home");
    const cleanupEnv = { ...env(), HOME: home, TALKING_STICK_DATA_DIR: path.join(fakeRoot, "cleanup-data"),
      PATH: `${npmBin}${path.delimiter}${fs.realpathSync(bin)}${path.delimiter}${process.env.PATH}` };
    const legacySkill = path.join(home, ".codex", "skills", "talking-stick");
    fs.mkdirSync(path.dirname(legacySkill), { recursive: true });
    fs.symlinkSync(npmSkill, legacySkill);
    recordManagedContent(legacySkill, "skill-copy", digestDirectory(npmSkill), { env: cleanupEnv });
    fs.appendFileSync(path.join(npmSkill, "SKILL.md"), "\nlocal customization");
    const args = ["scripts/install.sh", "--base-url", path.join(root, "assets"), "--bin-dir", bin, "--install-dir", install, "--remove-npm"];
    const blocked = execFileSync("sh", args, { env: cleanupEnv, encoding: "utf8" });
    expect(blocked).toContain("Not offering to remove");
    expect(fs.existsSync(log)).toBe(false);
    expect(fs.readlinkSync(legacySkill)).toBe(npmSkill);
    // Restoring the recorded content makes the link eligible for migration.
    fs.cpSync(path.join(path.dirname(fs.realpathSync(tt)), "skills", "talking-stick"), npmSkill, { recursive: true });
    const cleaned = execFileSync("sh", args, { env: cleanupEnv, encoding: "utf8" });
    expect(cleaned).toContain("Removed the npm copy");
    expect(fs.readFileSync(log, "utf8")).toBe("uninstall -g talking-stick");
    expect(fs.existsSync(npmPackage)).toBe(false);
    expect(fs.readlinkSync(legacySkill)).toBe(path.join(fs.realpathSync(install), "current", "skills", "talking-stick"));
    expect(fs.existsSync(path.join(legacySkill, "SKILL.md"))).toBe(true);
    expect(spawnSync(tt, ["--help"], { env: cleanupEnv }).status).toBe(0);
  });

  it("finds its skill beside the executable and self-updates with the installed directories", () => {
    const releaseRoot = path.dirname(fs.realpathSync(tt));
    const bundledSkill = path.join(releaseRoot, "skills", "talking-stick", "SKILL.md");
    expect(fs.existsSync(bundledSkill)).toBe(true);
    fs.mkdirSync(path.join(root, "home", ".codex"), { recursive: true });
    execFileSync(tt, ["install", "codex", "--copy"], { env: env(), encoding: "utf8" });
    expect(fs.readFileSync(path.join(root, "home", ".agents", "skills", "talking-stick", "SKILL.md"), "utf8"))
      .toBe(fs.readFileSync(bundledSkill, "utf8"));
    const plan = execFileSync(tt, ["self-update", "--print"], { env: env(), encoding: "utf8" });
    expect(plan).toContain(path.join(releaseRoot, "scripts", "install.sh"));
    expect(plan).toContain(fs.realpathSync(install));
    expect(plan).toContain(fs.realpathSync(bin));
  });
});
