#!/usr/bin/env node
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const SKILLER_VERSION = process.env.TALKING_STICK_SKILLER_VERSION || "v0.1.0";
const SKILLER_MIN_VERSION = process.env.TALKING_STICK_SKILLER_MIN_VERSION || "0.1.0";
const SKILLER_REPO = process.env.TALKING_STICK_SKILLER_REPO || "mostlydev/skiller";
const INSTALL_DIR =
  process.env.TALKING_STICK_SKILLER_BIN_DIR || path.join(os.homedir(), ".local", "bin");

async function main() {
  if (
    process.env.TALKING_STICK_DISABLE_SKILLER ||
    process.env.TALKING_STICK_DISABLE_SKILLER_BOOTSTRAP
  ) {
    return;
  }

  const existing = findUsableSkiller();
  if (existing) return;

  const platform = skillerPlatform();
  const arch = skillerArch();
  const archiveSuffix = platform === "windows"
    ? `_${platform}_${arch}.zip`
    : `_${platform}_${arch}.tar.gz`;
  const baseUrl =
    process.env.SKILLER_RELEASE_BASE_URL ||
    `https://github.com/${SKILLER_REPO}/releases/download/${SKILLER_VERSION}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-skiller-bootstrap-"));

  try {
    const checksumsPath = path.join(tempDir, "checksums.txt");
    await fetchToFile(joinUrl(baseUrl, "checksums.txt"), checksumsPath);
    const checksums = parseChecksums(fs.readFileSync(checksumsPath, "utf8"));
    const archiveName = Object.keys(checksums).find(
      (name) => name.startsWith("skiller_") && name.endsWith(archiveSuffix)
    );
    if (!archiveName) {
      throw new Error(`no skiller archive found for ${platform}/${arch}`);
    }

    const archivePath = path.join(tempDir, archiveName);
    await fetchToFile(joinUrl(baseUrl, archiveName), archivePath);
    const actual = sha256File(archivePath);
    const expected = checksums[archiveName];
    if (actual !== expected) {
      throw new Error(`checksum mismatch for ${archiveName}`);
    }

    const extractDir = path.join(tempDir, "extract");
    fs.mkdirSync(extractDir, { recursive: true });
    extractArchive(archivePath, extractDir, platform);
    const binary = findBinary(extractDir, platform);
    if (!binary) {
      throw new Error("archive did not contain skiller binary");
    }

    fs.mkdirSync(INSTALL_DIR, { recursive: true });
    const installPath = path.join(INSTALL_DIR, platform === "windows" ? "skiller.exe" : "skiller");
    fs.copyFileSync(binary, installPath);
    fs.chmodSync(installPath, 0o755);

    const verified = readVersion(installPath);
    if (!verified || compareVersions(verified, SKILLER_MIN_VERSION) < 0) {
      throw new Error(`installed skiller did not satisfy ${SKILLER_MIN_VERSION}`);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function findUsableSkiller() {
  for (const candidate of skillerCandidates()) {
    const version = readVersion(candidate);
    if (version && compareVersions(version, SKILLER_MIN_VERSION) >= 0) {
      return candidate;
    }
  }
  return null;
}

function skillerCandidates() {
  const names = process.platform === "win32" ? ["skiller.exe", "skiller"] : ["skiller"];
  const candidates = [];
  if (process.env.SKILLER_BIN) candidates.push(process.env.SKILLER_BIN);
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) candidates.push(path.join(dir, name));
  }
  candidates.push(path.join(INSTALL_DIR, names[0]));
  return Array.from(new Set(candidates));
}

function readVersion(binary) {
  if (!binary || !fs.existsSync(binary)) return null;
  const result = childProcess.spawnSync(binary, ["version", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

function skillerPlatform() {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "linux") return "linux";
  if (process.platform === "win32") return "windows";
  throw new Error(`unsupported platform: ${process.platform}`);
}

function skillerArch() {
  if (process.arch === "x64") return "amd64";
  if (process.arch === "arm64") return "arm64";
  throw new Error(`unsupported architecture: ${process.arch}`);
}

function parseChecksums(text) {
  const checksums = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+(.+)$/);
    if (match) checksums[match[2]] = match[1].toLowerCase();
  }
  return checksums;
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function extractArchive(archivePath, extractDir, platform) {
  if (archivePath.endsWith(".tar.gz")) {
    run("tar", ["-xzf", archivePath, "-C", extractDir]);
    return;
  }
  if (archivePath.endsWith(".zip")) {
    if (platform === "windows") {
      const script = `Expand-Archive -LiteralPath ${psQuote(archivePath)} -DestinationPath ${psQuote(extractDir)} -Force`;
      run("powershell", ["-NoProfile", "-Command", script]);
      return;
    }
    run("unzip", ["-q", archivePath, "-d", extractDir]);
    return;
  }
  throw new Error(`unsupported archive: ${archivePath}`);
}

function run(command, args) {
  const result = childProcess.spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    throw new Error(`${command} failed: ${detail}`);
  }
}

function findBinary(root, platform) {
  const names = new Set(platform === "windows" ? ["skiller.exe", "skiller"] : ["skiller"]);
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile() && names.has(entry.name)) {
        return entryPath;
      }
    }
  }
  return null;
}

function fetchToFile(url, dest, redirects = 0) {
  if (url.startsWith("file://")) {
    fs.copyFileSync(new URL(url), dest);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        if (
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.resume();
          if (redirects > 5) {
            reject(new Error(`too many redirects for ${url}`));
            return;
          }
          fetchToFile(new URL(response.headers.location, url).toString(), dest, redirects + 1)
            .then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`download failed ${response.statusCode}: ${url}`));
          return;
        }
        const file = fs.createWriteStream(dest, { mode: 0o644 });
        response.pipe(file);
        file.on("finish", () => {
          file.close(resolve);
        });
        file.on("error", reject);
      })
      .on("error", reject);
  });
}

function joinUrl(base, name) {
  return `${base.replace(/\/$/, "")}/${name}`;
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return -1;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

function parseVersion(value) {
  const match = String(value).trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
