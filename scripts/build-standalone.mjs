#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

// Bun names Windows "windows"; Node reports it as "win32".
const platform = process.platform === "win32" ? "windows" : process.platform;
const target = process.argv[2] ?? `bun-${platform}-${process.arch}`;
const match = /^bun-(darwin|linux|windows)-(x64|arm64)(-baseline)?$/.exec(target);
if (!match) throw new Error(`Unsupported target: ${target}`);
const [, os, arch] = match;
const executable = os === "windows" ? "tt.exe" : "tt";
const { version } = JSON.parse(fs.readFileSync("package.json", "utf8"));
const output = path.resolve(process.env.TT_RELEASE_DIR ?? "release-dist");
const name = `talking-stick_${version}_${os}_${arch}`;
fs.mkdirSync(output, { recursive: true });
const stage = fs.mkdtempSync(path.join(output, ".build-"));
try {
  execFileSync("bun", ["build", "--compile", "--external=better-sqlite3", `--target=${target}`, "src/standalone.ts", "--outfile", path.join(stage, executable)], { stdio: "inherit" });
  fs.copyFileSync("package.json", path.join(stage, "package.json"));
  fs.copyFileSync("LICENSE.md", path.join(stage, "LICENSE.md"));
  fs.cpSync("skills", path.join(stage, "skills"), { recursive: true });
  fs.mkdirSync(path.join(stage, "scripts"));
  fs.copyFileSync("scripts/install.sh", path.join(stage, "scripts/install.sh"));
  const archive = `${name}.tar.gz`;
  // Relative paths: GNU tar reads a "C:" drive prefix as a remote host.
  execFileSync("tar", ["-czf", archive, "-C", path.basename(stage), executable, "package.json", "LICENSE.md", "skills", "scripts"], { cwd: output });
  const digest = createHash("sha256").update(fs.readFileSync(path.join(output, archive))).digest("hex");
  fs.writeFileSync(path.join(output, `${name}.sha256`), `${digest}  ${archive}\n`);
  console.log(path.join(output, archive));
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
