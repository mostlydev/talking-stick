import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STANDALONE_INSTALL_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/mostlydev/shrooms/master/scripts/install.sh | sh";

// Shown to humans only (help and self-update), never on JSON or agent paths.
export const STANDALONE_MIGRATION_NOTICE = [
  "Talking Stick now ships as a standalone binary; the npm package is no longer updated.",
  `Install it with: ${STANDALONE_INSTALL_COMMAND}`,
  "then remove the npm copy: npm uninstall -g talking-stick"
].join("\n");

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
export type InstallSource = PackageManager | "dev" | "unknown";

export interface DetectInstallSourceInput {
  binaryPath: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export function detectInstallSource(input: DetectInstallSourceInput): InstallSource {
  const p = normalize(input.binaryPath);

  // pnpm global layout: ~/.local/share/pnpm/... or pnpm-prefixed segments.
  if (/(^|\/)\.local\/share\/pnpm\//.test(p)) return "pnpm";
  if (/(^|\/)pnpm\/global\//.test(p)) return "pnpm";

  // Yarn classic global layout: ~/.config/yarn/global/... or /yarn/global/.
  if (/(^|\/)yarn\/global\//.test(p)) return "yarn";

  // Bun global layout: ~/.bun/install/global/...
  if (/(^|\/)\.bun\/install\//.test(p)) return "bun";

  // npm-managed layouts (also covers Homebrew node, nvm, mise, asdf, volta — any
  // tool that puts the package under a standard `node_modules/talking-stick`
  // segment). Has to come AFTER the pnpm/yarn/bun checks because they also have
  // node_modules segments.
  if (/\/node_modules\/talking-stick\//.test(p)) return "npm";

  // Anything else (a checked-out source tree, an unknown layout) is treated as
  // a development install. Self-update there would be wrong; we tell the user
  // to git pull instead.
  return "dev";
}

export interface UpdateCommand {
  command: string;
  args: string[];
  description: string;
}

export function planSelfUpdate(source: InstallSource): UpdateCommand | null {
  switch (source) {
    case "npm":
      return {
        command: "npm",
        args: ["install", "-g", "talking-stick@latest"],
        description: "npm install -g talking-stick@latest"
      };
    case "pnpm":
      return {
        command: "pnpm",
        args: ["install", "-g", "talking-stick@latest"],
        description: "pnpm install -g talking-stick@latest"
      };
    case "yarn":
      return {
        command: "yarn",
        args: ["global", "add", "talking-stick@latest"],
        description: "yarn global add talking-stick@latest"
      };
    case "bun":
      return {
        command: "bun",
        args: ["add", "-g", "talking-stick@latest"],
        description: "bun add -g talking-stick@latest"
      };
    case "dev":
    case "unknown":
      return null;
  }
}

export function resolveCurrentBinaryPath(metaUrl: string): string {
  const target = fileURLToPath(metaUrl);
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

export function isPackageManager(value: string): value is PackageManager {
  return value === "npm" || value === "pnpm" || value === "yarn" || value === "bun";
}

function normalize(value: string): string {
  // Treat backslashes as forward slashes for cross-platform regex matching.
  return value.replace(/\\/g, "/");
}

// A standalone install lives at <install_dir>/releases/<release>/tt, and the
// installer records its bin directory in <install_dir>/install-receipt.
// Updating reruns that release's own installer with the same directories, so
// custom --install-dir/--bin-dir choices survive.
export function planStandaloneUpdate(releaseRoot: string): UpdateCommand {
  const installDir = path.dirname(path.dirname(releaseRoot));
  const installer = path.join(releaseRoot, "scripts", "install.sh");
  const args = [installer, "--install-dir", installDir];
  try {
    const receipt = fs.readFileSync(path.join(installDir, "install-receipt"), "utf8");
    const binDir = /^bin_dir=(.+)$/m.exec(receipt)?.[1];
    if (binDir) args.push("--bin-dir", binDir);
  } catch {
    // Without a receipt the installer's default bin directory applies.
  }
  return { command: "sh", args, description: `sh ${args.map(shellWord).join(" ")}` };
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
