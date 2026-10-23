import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { ACK_LINK_PATTERN } from "./cli/chat-links.js";
import { runHerdrJson, type HerdrRunner } from "./herdr.js";
import { resolveCurrentBinaryPath } from "./self-update.js";
import { isStandalone, standaloneLinkRoot } from "./standalone-mode.js";

export const HERDR_PLUGIN_ID = "talking-stick.chat";
// Plugin link_handlers first shipped in Herdr 0.7.0.
export const HERDR_PLUGIN_MIN_VERSION = "0.7.0";

export type HerdrPluginState = "enabled" | "disabled" | "missing" | "unavailable";

export function herdrPluginDir(dataDir: string): string {
  return path.join(dataDir, "herdr-plugin");
}

// Herdr runs argv directly, without a shell or the user's PATH, so the
// command is absolute. A release goes through <install-dir>/current, which
// survives updates; a development or npm copy runs node on its own entry.
export function chatLinkArgv(cliEntryUrl: string): string[] {
  if (isStandalone()) return [path.join(standaloneLinkRoot(), path.basename(process.execPath)), "chat-link"];
  return [process.execPath, resolveCurrentBinaryPath(cliEntryUrl), "chat-link"];
}

// JSON strings are valid TOML basic strings.
export function herdrPluginManifest(argv: readonly string[]): string {
  const quote = (value: string) => JSON.stringify(value);
  return [
    `id = ${quote(HERDR_PLUGIN_ID)}`,
    `name = "Talking Stick chat"`,
    `version = "1"`,
    `min_herdr_version = ${quote(HERDR_PLUGIN_MIN_VERSION)}`,
    `description = "Ctrl-click the tt chat unread control to visit missed messages."`,
    `platforms = ["linux", "macos"]`,
    "",
    "[[actions]]",
    `id = "ack-pin"`,
    `title = "Visit unread message"`,
    `command = [${argv.map(quote).join(", ")}]`,
    "",
    "[[link_handlers]]",
    `id = "ack-pin"`,
    `title = "Visit unread message"`,
    `pattern = ${quote(ACK_LINK_PATTERN)}`,
    `action = "ack-pin"`,
    ""
  ].join("\n");
}

export function readHerdrPluginState(runner: HerdrRunner): HerdrPluginState {
  let plugins: unknown[];
  try {
    const result = runHerdrJson(runner, ["plugin", "list", "--json"], { timeoutMs: 2_000 });
    plugins = Array.isArray(result.plugins) ? result.plugins : [];
  } catch {
    return "unavailable";
  }
  const plugin = plugins.find((candidate) =>
    typeof candidate === "object" && candidate !== null &&
    (candidate as Record<string, unknown>).plugin_id === HERDR_PLUGIN_ID
  ) as Record<string, unknown> | undefined;
  if (!plugin) return "missing";
  return plugin.enabled === true ? "enabled" : "disabled";
}

export type HerdrPluginInstallStatus = "linked" | "updated" | "unchanged";

export interface HerdrPluginInstallResult {
  status: HerdrPluginInstallStatus;
  dir: string;
}

// Link (or relink, when the manifest changed) the generated plugin. Herdr
// records the linked directory, so the manifest lives in our data dir.
export function installHerdrPlugin(input: {
  runner: HerdrRunner;
  dataDir: string;
  argv: readonly string[];
}): HerdrPluginInstallResult {
  const dir = herdrPluginDir(input.dataDir);
  const manifestPath = path.join(dir, "herdr-plugin.toml");
  const manifest = herdrPluginManifest(input.argv);
  let previous: string | null = null;
  try {
    previous = fs.readFileSync(manifestPath, "utf8");
  } catch {}
  const changed = previous !== manifest;
  if (changed) {
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(manifestPath, manifest);
  }
  const state = readHerdrPluginState(input.runner);
  if (state === "unavailable") throw new Error("Herdr did not list its plugins; is herdr 0.7.0 or newer on PATH?");
  if (state !== "missing" && !changed) {
    if (state === "disabled") input.runner(["plugin", "enable", HERDR_PLUGIN_ID]);
    return { status: state === "disabled" ? "updated" : "unchanged", dir };
  }
  if (state !== "missing") input.runner(["plugin", "unlink", HERDR_PLUGIN_ID]);
  input.runner(["plugin", "link", dir, "--enabled"]);
  return { status: state === "missing" ? "linked" : "updated", dir };
}

export function uninstallHerdrPlugin(input: { runner: HerdrRunner; dataDir: string }): "removed" | "not_installed" {
  const state = readHerdrPluginState(input.runner);
  if (state === "enabled" || state === "disabled") input.runner(["plugin", "unlink", HERDR_PLUGIN_ID]);
  const dir = herdrPluginDir(input.dataDir);
  const existed = fs.existsSync(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return state === "enabled" || state === "disabled" || existed ? "removed" : "not_installed";
}
