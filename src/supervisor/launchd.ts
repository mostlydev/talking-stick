import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The supervisor as a macOS user agent. Install and uninstall are explicit;
// nothing installs it implicitly.

export const LAUNCHD_LABEL = "com.talking-stick.supervisor";

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * What the agent runs. A compiled binary is its own entry point; an
 * installed release runs through <install-dir>/current, which self-update
 * moves, so the agent follows updates. Under Node, node runs the package's
 * cli.js.
 */
export function supervisorProgram(input: { standalone: boolean; execPath: string; cliEntry: string; releaseRoot: string | null }): string[] {
  if (!input.standalone) return [input.execPath, input.cliEntry, "supervisor", "run"];
  const executable = input.releaseRoot
    ? path.join(path.dirname(path.dirname(input.releaseRoot)), "current", path.basename(input.execPath))
    : input.execPath;
  return [executable, "supervisor", "run"];
}

export function launchAgentPath(homeDir = os.homedir()): string {
  return path.join(homeDir, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

/** The agent runs tt supervisor run for one data directory, with owner-only files. */
export function launchAgentPlist(input: { program: string[]; dataDir: string; logPath: string }): string {
  const args = input.program.map((arg) => `    <string>${xml(arg)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TALKING_STICK_DATA_DIR</key>
    <string>${xml(input.dataDir)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${xml(input.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(input.logPath)}</string>
</dict>
</plist>
`;
}

export type LaunchctlRunner = (args: string[]) => void;

const systemLaunchctl: LaunchctlRunner = (args) => { execFileSync("launchctl", args, { stdio: "ignore" }); };

export function installLaunchAgent(input: { program: string[]; dataDir: string; logPath: string; homeDir?: string;
  launchctl?: LaunchctlRunner }): string {
  if (process.platform !== "darwin" && !input.launchctl) throw new Error("tt supervisor install supports macOS launchd only.");
  // The agent must run something that exists, not report installed and fail at login.
  const [executable, script] = input.program;
  if (!executable || !fs.existsSync(executable)) throw new Error(`The supervisor's executable ${executable ?? ""} does not exist.`);
  if (script && script !== "supervisor" && !fs.existsSync(script)) throw new Error(`The supervisor's entry ${script} does not exist.`);
  const file = launchAgentPath(input.homeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.dirname(input.logPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, launchAgentPlist(input), { mode: 0o644 });
  const domain = `gui/${process.getuid?.() ?? 0}`;
  const launchctl = input.launchctl ?? systemLaunchctl;
  try { launchctl(["bootout", `${domain}/${LAUNCHD_LABEL}`]); } catch { /* not loaded */ }
  launchctl(["bootstrap", domain, file]);
  return file;
}

export function uninstallLaunchAgent(input: { homeDir?: string; launchctl?: LaunchctlRunner } = {}): boolean {
  const file = launchAgentPath(input.homeDir);
  const launchctl = input.launchctl ?? systemLaunchctl;
  try { launchctl(["bootout", `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`]); } catch { /* not loaded */ }
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}
