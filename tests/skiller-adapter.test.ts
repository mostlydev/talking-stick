import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  resolveSkiller,
  runSkillerCleanupDuplicates,
  runSkillerDryRun,
  runSkillerInstall,
  runSkillerUninstall
} from "../src/skiller-adapter.js";
import { FileAuditLog } from "../src/install-audit.js";

describe("skiller adapter", () => {
  test("detects a compatible SKILLER_BIN", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-fake-skiller-"));
    const fake = writeFakeSkiller(root);

    const result = resolveSkiller({
      env: {
        SKILLER_BIN: fake,
        PATH: process.env.PATH ?? "",
        HOME: root
      }
    });

    expect(result.ok).toBe(true);
    expect(result.path).toBe(fake);
    expect(result.version).toBe("v0.1.0");
  });

  test("returns null when skiller is disabled and throws when required", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-no-skiller-"));

    await expect(
      runSkillerInstall({
        harnesses: ["codex"],
        env: {
          TALKING_STICK_DISABLE_SKILLER: "1",
          SKILLER_BIN: "",
          PATH: "",
          HOME: root
        },
        homeDir: root
      })
    ).resolves.toBeNull();

    await expect(
      runSkillerInstall({
        harnesses: ["codex"],
        env: {
          TALKING_STICK_REQUIRE_SKILLER: "1",
          SKILLER_BIN: "",
          PATH: "",
          HOME: root
        },
        homeDir: root
      })
    ).rejects.toThrow(/skiller unavailable/);
  });

  test("generates a manifest and adapts skiller install and cleanup output", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-skiller-adapter-"));
    const fake = writeFakeSkiller(root);
    const logPath = path.join(root, "calls.jsonl");
    const auditPath = path.join(root, "audit.jsonl");
    const env = {
      SKILLER_BIN: fake,
      FAKE_SKILLER_LOG: logPath,
      PATH: process.env.PATH ?? "",
      HOME: root,
      TALKING_STICK_DATA_DIR: path.join(root, "data")
    };

    const lines = await runSkillerDryRun("install", {
      harnesses: ["codex"],
      env,
      homeDir: root,
      link: true
    });
    expect(lines?.join("\n")).toContain("[codex] link ");
    expect(lines?.join("\n")).toContain(".agents/skills/talking-stick");

    const install = await runSkillerInstall({
      harnesses: ["codex"],
      env,
      homeDir: root,
      link: true
    });
    expect(install?.[0]?.status).toBe("added");
    expect(install?.[0]?.harness).toBe("codex");

    const cleanup = await runSkillerCleanupDuplicates({
      harnesses: ["codex"],
      env,
      homeDir: root,
      reason: "manual",
      audit: new FileAuditLog(auditPath)
    });
    expect(cleanup?.[0]).toMatchObject({
      harness: "codex",
      action: "removed",
      target_type: "skill"
    });
    const audit = fs
      .readFileSync(auditPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(audit[0]).toMatchObject({
      reason: "manual",
      harness: "codex",
      target_type: "skill",
      action: "removed",
      server_name: "talking-stick"
    });

    const calls = fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; manifest: string });
    expect(calls.some((call) => call.args.includes("--dry-run"))).toBe(true);
    expect(calls.some((call) => call.args[0] === "cleanup-duplicates")).toBe(true);
    expect(calls[0].manifest).toContain('targets = ["codex"]');
    expect(calls[0].manifest).toContain('source = "');
  });

  test("does not invoke skiller for missing proprietary Claude Code root", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-skiller-claude-missing-"));
    const fake = writeFakeSkiller(root);
    const logPath = path.join(root, "calls.jsonl");
    const env = {
      SKILLER_BIN: fake,
      FAKE_SKILLER_LOG: logPath,
      PATH: process.env.PATH ?? "",
      HOME: root
    };

    await expect(
      runSkillerInstall({
        harnesses: ["claude-code"],
        env,
        homeDir: root,
        skipMissing: true
      })
    ).resolves.toBeNull();
    expect(fs.existsSync(logPath)).toBe(false);

    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    const results = await runSkillerInstall({
      harnesses: ["claude-code"],
      env,
      homeDir: root,
      skipMissing: true
    });
    expect(results?.[0]).toMatchObject({ harness: "claude-code", status: "added" });
    const calls = fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { manifest: string });
    expect(calls[0].manifest).toContain('targets = ["claude-code"]');
  });

  test("reports shared uninstall protection as skipped rather than already absent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-skiller-shared-skip-"));
    const fake = writeFakeSkiller(root);
    const env = {
      SKILLER_BIN: fake,
      FAKE_SKILLER_SHARED_SKIP: "1",
      PATH: process.env.PATH ?? "",
      HOME: root
    };

    const results = await runSkillerUninstall({
      harnesses: ["codex"],
      env,
      homeDir: root,
      skipMissing: true
    });

    expect(results?.[0]).toMatchObject({ harness: "codex", status: "skipped" });
  });

  test.skipIf(!process.env.SKILLER_BIN)(
    "conforms to a real skiller binary for install, no-op, and Option-B uninstall",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-real-skiller-"));
      const dataDir = path.join(root, "data");
      fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
      const env = {
        SKILLER_BIN: process.env.SKILLER_BIN!,
        PATH: process.env.PATH ?? "",
        HOME: root,
        TALKING_STICK_DATA_DIR: dataDir
      };
      const sharedTarget = path.join(root, ".agents", "skills", "talking-stick");
      const claudeTarget = path.join(root, ".claude", "skills", "talking-stick");

      const install = await runSkillerInstall({
        harnesses: ["codex", "claude-code"],
        env,
        homeDir: root,
        link: true,
        skipMissing: true
      });
      expect(install?.some((result) => result.harness === "codex" && result.ok)).toBe(true);
      expect(install?.some((result) => result.harness === "claude-code" && result.ok)).toBe(true);
      expect(fs.lstatSync(sharedTarget).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(claudeTarget).isSymbolicLink()).toBe(true);

      const secondInstall = await runSkillerInstall({
        harnesses: ["codex", "claude-code"],
        env,
        homeDir: root,
        link: true,
        skipMissing: true
      });
      expect(secondInstall?.every((result) => result.ok)).toBe(true);
      expect(
        secondInstall?.every((result) =>
          ["already_present", "skipped", "ok"].includes(result.status)
        )
      ).toBe(true);

      const codexUninstall = await runSkillerUninstall({
        harnesses: ["codex"],
        env,
        homeDir: root,
        skipMissing: true
      });
      expect(codexUninstall?.[0]).toMatchObject({ harness: "codex", status: "skipped" });
      expect(fs.existsSync(sharedTarget)).toBe(true);

      await runSkillerUninstall({
        harnesses: ["claude-code"],
        env,
        homeDir: root,
        skipMissing: true
      });
      await runSkillerUninstall({
        harnesses: [],
        removeShared: true,
        env,
        homeDir: root,
        skipMissing: true
      });
      expect(fs.existsSync(claudeTarget)).toBe(false);
      expect(fs.existsSync(sharedTarget)).toBe(false);
    }
  );
});

describe("skiller bootstrap script", () => {
  test("installs a checksummed local release archive", () => {
    if (process.platform === "win32") return;

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-skiller-bootstrap-"));
    const assets = path.join(root, "assets");
    const binDir = path.join(root, "bin");
    fs.mkdirSync(assets, { recursive: true });
    const archiveName = `skiller_0.1.0_${skillerPlatform()}_${skillerArch()}.tar.gz`;
    const sourceDir = path.join(root, "source");
    fs.mkdirSync(sourceDir, { recursive: true });
    writeFakeSkiller(sourceDir, "skiller");
    const archivePath = path.join(assets, archiveName);
    const tar = spawnSync("tar", ["-czf", archivePath, "-C", sourceDir, "skiller"], {
      encoding: "utf8"
    });
    expect(tar.status).toBe(0);
    const checksum = sha256File(archivePath);
    fs.writeFileSync(path.join(assets, "checksums.txt"), `${checksum}  ${archiveName}\n`, "utf8");

    const script = path.resolve("scripts", "skiller-bootstrap.cjs");
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        SKILLER_BIN: "",
        SKILLER_RELEASE_BASE_URL: `file://${assets}`,
        TALKING_STICK_SKILLER_BIN_DIR: binDir
      }
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const installed = path.join(binDir, "skiller");
    expect(fs.existsSync(installed)).toBe(true);
    const version = spawnSync(installed, ["version", "--json"], { encoding: "utf8" });
    expect(JSON.parse(version.stdout).version).toBe("v0.1.0");
  });
});

function writeFakeSkiller(root: string, name = "fake-skiller"): string {
  const fake = path.join(root, name);
  fs.writeFileSync(
    fake,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "version") {
  console.log(JSON.stringify({ schema: "skiller-version.v1", version: "v0.1.0" }));
  process.exit(0);
}
const home = valueAfter("--home") || process.env.HOME || "";
const manifestPath = valueAfter("--manifest");
const manifest = manifestPath ? fs.readFileSync(manifestPath, "utf8") : "";
const targets = Array.from(manifest.matchAll(/targets = \\[([^\\]]*)\\]/g))
  .flatMap((match) => match[1].split(",").map((value) => value.trim().replace(/^"|"$/g, "")))
  .filter(Boolean);
const target = targets[0] || "codex";
if (process.env.FAKE_SKILLER_LOG) {
  fs.appendFileSync(process.env.FAKE_SKILLER_LOG, JSON.stringify({ args, manifest }) + "\\n");
}
const command = args[0];
if (command === "cleanup-duplicates") {
  write({ target, action: "remove-duplicate", status: args.includes("--dry-run") ? "dry-run" : "removed", path: duplicatePath(target) });
} else if (command === "uninstall") {
  if (process.env.FAKE_SKILLER_SHARED_SKIP) {
    write({ target, action: "skip-uninstall", status: "skipped", reason: "shared target requires --shared or --all", path: installPath(target) });
  } else {
    write({ target, action: "remove-owned", status: args.includes("--dry-run") ? "dry-run" : "removed", path: installPath(target) });
  }
} else {
  write({ target, action: "install-link", status: args.includes("--dry-run") ? "dry-run" : "installed", path: installPath(target) });
}
function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : "";
}
function installPath(target) {
  return target === "claude-code"
    ? path.join(home, ".claude", "skills", "talking-stick")
    : path.join(home, ".agents", "skills", "talking-stick");
}
function duplicatePath(target) {
  return target === "claude-code"
    ? path.join(home, ".claude", "skills", "talking-stick")
    : path.join(home, "." + target, "skills", "talking-stick");
}
function write(input) {
  console.log(JSON.stringify({
    schema: "skiller-plan.v1",
    operation: command,
    sources: [{ id: "source-001", source_realpath: "/tmp/talking-stick/skills/talking-stick" }],
    actions: [{
      action: input.action,
      status: input.status,
      reason: input.reason,
      source_id: "source-001",
      skill: { requested_targets: [input.target] },
      target: { id: input.target === "claude-code" ? "claude-code" : "agents", kind: input.target === "claude-code" ? "proprietary" : "shared", path: input.path, requested_targets: [input.target] }
    }]
  }));
}
`,
    "utf8"
  );
  fs.chmodSync(fake, 0o755);
  return fake;
}

function skillerPlatform(): string {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "linux") return "linux";
  throw new Error(`unsupported test platform: ${process.platform}`);
}

function skillerArch(): string {
  if (process.arch === "x64") return "amd64";
  if (process.arch === "arm64") return "arm64";
  throw new Error(`unsupported test arch: ${process.arch}`);
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}
