import { spawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import {
  SUPPORTED_HARNESSES,
  isDeprecatedHarness,
  type HarnessId
} from "./harness-model.js";

export {
  SUPPORTED_HARNESSES,
  isDeprecatedHarness,
  type HarnessId
} from "./harness-model.js";

export const GROK_SESSION_HOOK_FILE = "talking-stick-session.json";
export const DEFAULT_GROK_SESSION_HOOK_COMMAND =
  ": talking-stick-grok-session-hook; if command -v tt >/dev/null 2>&1; then tt grok-session-hook >/dev/null 2>/dev/null || true; fi";
export const GROK_SESSION_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "SessionEnd"
] as const;

export interface InstallEnv {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homeDir: string;
}

export interface InstallerHooks {
  run?: (command: string, args: string[], options?: SpawnOptions) => Promise<ExecResult>;
  readFile?: (filePath: string) => string | null;
  writeFile?: (filePath: string, data: string) => void;
  ensureDir?: (dirPath: string) => void;
  pathExists?: (filePath: string) => boolean;
  which?: (binary: string) => string | null;
}

export interface InstallOptions extends Partial<InstallEnv>, InstallerHooks {
  skipMissing?: boolean;
}

export interface ExecAction {
  kind: "exec";
  harness: HarnessId;
  command: string;
  args: string[];
  description: string;
  operation?: InstallOperation;
  inspect?: () => InstallTargetState;
}

export interface FilePatchAction {
  kind: "file-patch";
  harness: HarnessId;
  filePath: string;
  description: string;
  operation?: InstallOperation;
  inspect?: () => InstallTargetState;
  apply: () => void;
}

export interface SkipAction {
  kind: "skip";
  harness: HarnessId;
  description: string;
  message: string;
  operation?: undefined;
}

export type InstallAction = ExecAction | FilePatchAction | SkipAction;

export type InstallOperation = "install" | "uninstall";
export type InstallStatus =
  | "added"
  | "already_present"
  | "updated"
  | "update_available"
  | "removed"
  | "already_absent"
  | "skipped"
  | "ok"
  | "failed";

export interface InstallResult {
  harness: HarnessId;
  ok: boolean;
  action: InstallAction;
  status: InstallStatus;
  message: string;
  skipped?: boolean;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ExecInvocation {
  command: string;
  args: string[];
  options?: SpawnOptions;
}

interface ExecInvocationError {
  error: string;
}

export type InstallTargetState =
  | "absent"
  | "present"
  | "different"
  | "customized"
  | "unknown";

interface ResolvedOptions {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homeDir: string;
  skipMissing: boolean;
  hooks: Required<InstallerHooks>;
}

export class MissingHarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingHarnessError";
  }
}

function resolveOptions(options: InstallOptions = {}): ResolvedOptions {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();

  return {
    env,
    platform,
    homeDir,
    skipMissing: options.skipMissing ?? false,
    hooks: {
      run: options.run ?? defaultRun,
      readFile: options.readFile ?? defaultReadFile,
      writeFile: options.writeFile ?? defaultWriteFile,
      ensureDir: options.ensureDir ?? defaultEnsureDir,
      pathExists: options.pathExists ?? defaultPathExists,
      which: options.which ?? ((binary) => defaultWhich(binary, { env, platform }))
    }
  };
}

function defaultRun(command: string, args: string[], options: SpawnOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 0,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8")
      });
    });
  });
}

function defaultReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function defaultWriteFile(filePath: string, data: string): void {
  writeFileAtomic(filePath, data);
}

function defaultEnsureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function defaultPathExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

function defaultWhich(
  binary: string,
  options: Pick<InstallEnv, "env" | "platform">
): string | null {
  const pathEnv = options.env.PATH ?? options.env.Path ?? "";
  const separator = options.platform === "win32" ? ";" : ":";
  const extensions =
    options.platform === "win32"
      ? (options.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
      : [""];
  for (const dir of pathEnv.split(separator)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, binary + ext);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function resolveOpencodeConfigPath(options: InstallOptions = {}): string {
  return path.join(resolveOpencodeConfigDir(options), "opencode.json");
}

export function resolveOpencodeConfigDir(options: InstallOptions = {}): string {
  const resolved = resolveOptions(options);
  return resolveOpencodeConfigDirFromResolved(resolved);
}

export function resolveHarnessConfigDir(
  harness: HarnessId,
  options: InstallOptions = {}
): string {
  const resolved = resolveOptions(options);
  return resolveHarnessConfigDirFromResolved(harness, resolved);
}

export function resolveGrokSessionHookPath(options: InstallOptions = {}): string {
  const resolved = resolveOptions(options);
  return path.join(
    resolveGrokConfigDirFromResolved(resolved),
    "hooks",
    GROK_SESSION_HOOK_FILE
  );
}

function resolveOpencodeConfigDirFromResolved(resolved: ResolvedOptions): string {
  const xdg = resolved.env.XDG_CONFIG_HOME?.trim();
  const base = xdg && xdg.length > 0 ? xdg : path.join(resolved.homeDir, ".config");
  return path.join(base, "opencode");
}

function resolveGrokConfigDirFromResolved(resolved: ResolvedOptions): string {
  const grokHome = resolved.env.GROK_HOME?.trim();
  return grokHome && grokHome.length > 0
    ? grokHome
    : path.join(resolved.homeDir, ".grok");
}

function resolveHarnessConfigDirFromResolved(
  harness: HarnessId,
  resolved: ResolvedOptions
): string {
  switch (harness) {
    case "claude-code":
      return path.join(resolved.homeDir, ".claude");
    case "codex":
      return path.join(resolved.homeDir, ".codex");
    case "antigravity":
      return path.join(resolved.homeDir, ".agents");
    case "gemini":
      return path.join(resolved.homeDir, ".gemini");
    case "grok":
      return resolveGrokConfigDirFromResolved(resolved);
    case "opencode":
      return resolveOpencodeConfigDirFromResolved(resolved);
    default:
      throw new Error(`Unknown harness: ${harness satisfies never}`);
  }
}

export function skipAction(harness: HarnessId, message: string): SkipAction {
  return {
    kind: "skip",
    harness,
    description: message,
    message
  };
}

export function planGrokSessionHookInstall(
  options: InstallOptions = {}
): InstallAction {
  const resolved = resolveOptions(options);
  const grokConfigDir = resolveGrokConfigDirFromResolved(resolved);
  const filePath = resolveGrokSessionHookPath(options);
  if (resolved.skipMissing && !resolved.hooks.pathExists(grokConfigDir)) {
    return skipAction("grok", `grok config directory not found: ${grokConfigDir}`);
  }

  return {
    kind: "file-patch",
    harness: "grok",
    filePath,
    description: `write Grok session hook ${filePath}`,
    operation: "install",
    inspect: () => inspectGrokSessionHook(filePath, resolved),
    apply: () => writeGrokSessionHook(filePath, resolved)
  };
}

export function planGrokSessionHookUninstall(
  options: InstallOptions = {}
): InstallAction {
  const resolved = resolveOptions(options);
  const grokConfigDir = resolveGrokConfigDirFromResolved(resolved);
  const filePath = resolveGrokSessionHookPath(options);
  if (resolved.skipMissing && !resolved.hooks.pathExists(grokConfigDir)) {
    return skipAction("grok", `grok config directory not found: ${grokConfigDir}`);
  }

  return {
    kind: "file-patch",
    harness: "grok",
    filePath,
    description: `remove Grok session hook ${filePath}`,
    operation: "uninstall",
    inspect: () =>
      resolved.hooks.readFile(filePath) === null ? "absent" : "present",
    apply: () => removeGrokSessionHook(filePath, resolved)
  };
}

export function buildGrokSessionHookConfig(): string {
  const hook = {
    type: "command",
    command: DEFAULT_GROK_SESSION_HOOK_COMMAND,
    timeout: 5
  };
  const hooks = Object.fromEntries(
    GROK_SESSION_HOOK_EVENTS.map((event) => [
      event,
      [
        {
          hooks: [hook]
        }
      ]
    ])
  );
  return JSON.stringify({ hooks }, null, 2) + "\n";
}

function inspectGrokSessionHook(
  filePath: string,
  resolved: ResolvedOptions
): InstallTargetState {
  const existing = resolved.hooks.readFile(filePath);
  if (existing === null) return "absent";
  return existing === buildGrokSessionHookConfig() ? "present" : "different";
}

function writeGrokSessionHook(filePath: string, resolved: ResolvedOptions): void {
  resolved.hooks.ensureDir(path.dirname(filePath));
  resolved.hooks.writeFile(filePath, buildGrokSessionHookConfig());
}

function removeGrokSessionHook(filePath: string, resolved: ResolvedOptions): void {
  void resolved;
  try {
    fs.rmSync(filePath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export interface HarnessDetection {
  harness: HarnessId;
  detected: boolean;
  evidence: string;
}

export function detectHarness(harness: HarnessId, options: InstallOptions = {}): HarnessDetection {
  const resolved = resolveOptions(options);
  switch (harness) {
    case "claude-code": {
      const bin = resolved.hooks.which("claude");
      if (bin) return { harness, detected: true, evidence: bin };
      const configDir = resolveHarnessConfigDirFromResolved(harness, resolved);
      if (resolved.hooks.pathExists(configDir)) return { harness, detected: true, evidence: configDir };
      return { harness, detected: false, evidence: "claude not on PATH and no config directory" };
    }
    case "codex": {
      const bin = resolved.hooks.which("codex");
      if (bin) return { harness, detected: true, evidence: bin };
      const configDir = resolveHarnessConfigDirFromResolved(harness, resolved);
      if (resolved.hooks.pathExists(configDir)) return { harness, detected: true, evidence: configDir };
      return { harness, detected: false, evidence: "codex not on PATH and no config directory" };
    }
    case "antigravity": {
      const bin = resolved.hooks.which("agy");
      if (bin) return { harness, detected: true, evidence: bin };
      return { harness, detected: false, evidence: "agy not on PATH" };
    }
    case "gemini": {
      const bin = resolved.hooks.which("gemini");
      if (bin) return { harness, detected: true, evidence: bin };
      const configDir = resolveHarnessConfigDirFromResolved(harness, resolved);
      if (resolved.hooks.pathExists(configDir)) return { harness, detected: true, evidence: configDir };
      return { harness, detected: false, evidence: "gemini not on PATH and no config directory" };
    }
    case "grok": {
      const bin = resolved.hooks.which("grok");
      if (bin) return { harness, detected: true, evidence: bin };
      const configDir = resolveHarnessConfigDirFromResolved(harness, resolved);
      if (resolved.hooks.pathExists(configDir)) return { harness, detected: true, evidence: configDir };
      return { harness, detected: false, evidence: "grok not on PATH and no config directory" };
    }
    case "opencode": {
      const bin = resolved.hooks.which("opencode");
      if (bin) return { harness, detected: true, evidence: bin };
      const configPath = resolveOpencodeConfigPath(options);
      const existing = resolved.hooks.readFile(configPath);
      if (existing !== null) return { harness, detected: true, evidence: configPath };
      const configDir = resolveHarnessConfigDirFromResolved(harness, resolved);
      if (resolved.hooks.pathExists(configDir)) return { harness, detected: true, evidence: configDir };
      return { harness, detected: false, evidence: "opencode not on PATH and no config directory" };
    }
    default:
      throw new Error(`Unknown harness: ${harness satisfies never}`);
  }
}

export async function runAction(action: InstallAction, options: InstallOptions = {}): Promise<InstallResult> {
  const resolved = resolveOptions(options);
  if (action.kind === "skip") {
    return {
      harness: action.harness,
      ok: true,
      action,
      status: "skipped",
      message: action.message,
      skipped: true
    };
  }

  if (action.kind === "exec") {
    const invocation = resolveExecInvocation(action, resolved);
    if (!invocation) {
      return {
        harness: action.harness,
        ok: resolved.skipMissing,
        action,
        status: resolved.skipMissing ? "skipped" : "failed",
        message: `${action.command} not on PATH`,
        skipped: resolved.skipMissing
      };
    }

    if ("error" in invocation) {
      return {
        harness: action.harness,
        ok: false,
        action,
        status: "failed",
        message: invocation.error
      };
    }

    const beforeState = action.inspect?.() ?? "unknown";
    if (action.operation === "install" && beforeState === "present") {
      return {
        harness: action.harness,
        ok: true,
        action,
        status: "already_present",
        message: formatActionMessage(action, "already_present")
      };
    }
    if (action.operation === "install" && beforeState === "customized") {
      return {
        harness: action.harness,
        ok: true,
        action,
        status: "update_available",
        message: "Customized skill was preserved; pass --replace to overwrite it."
      };
    }
    if (action.operation === "uninstall" && beforeState === "absent") {
      return {
        harness: action.harness,
        ok: true,
        action,
        status: "already_absent",
        message: formatActionMessage(action, "already_absent")
      };
    }

    let result: ExecResult;
    try {
      result = await resolved.hooks.run(
        invocation.command,
        invocation.args,
        invocation.options
      );
    } catch (error) {
      return {
        harness: action.harness,
        ok: false,
        action,
        status: "failed",
        message: formatExecError(error)
      };
    }

    if (result.exitCode === 0) {
      const status = successStatusForOperation(action.operation, beforeState);
      return {
        harness: action.harness,
        ok: true,
        action,
        status,
        message: formatActionMessage(action, status, result.stdout.trim() || undefined)
      };
    }

    const errorMessage = result.stderr.trim() || result.stdout.trim() || `${action.command} exited with code ${result.exitCode}`;
    if (action.operation === "install" && isAlreadyPresentMessage(errorMessage)) {
      return {
        harness: action.harness,
        ok: true,
        action,
        status: "already_present",
        message: formatActionMessage(action, "already_present")
      };
    }
    if (action.operation === "uninstall" && isAlreadyAbsentMessage(errorMessage)) {
      return {
        harness: action.harness,
        ok: true,
        action,
        status: "already_absent",
        message: formatActionMessage(action, "already_absent")
      };
    }

    return {
      harness: action.harness,
      ok: false,
      action,
      status: "failed",
      message: errorMessage
    };
  }

  const beforeState = action.inspect?.() ?? "unknown";
  if (action.operation === "install" && beforeState === "present") {
    return {
      harness: action.harness,
      ok: true,
      action,
      status: "already_present",
      message: formatActionMessage(action, "already_present")
    };
  }
  if (action.operation === "install" && beforeState === "customized") {
    return {
      harness: action.harness,
      ok: true,
      action,
      status: "update_available",
      message: "Customized skill was preserved; pass --replace to overwrite it."
    };
  }
  if (action.operation === "uninstall" && beforeState === "absent") {
    return {
      harness: action.harness,
      ok: true,
      action,
      status: "already_absent",
      message: formatActionMessage(action, "already_absent")
    };
  }

  try {
    action.apply();
    const status = successStatusForOperation(action.operation, beforeState);
    return {
      harness: action.harness,
      ok: true,
      action,
      status,
      message: formatActionMessage(action, status, `Updated ${action.filePath}`)
    };
  } catch (error) {
    if (resolved.skipMissing && error instanceof MissingHarnessError) {
      return {
        harness: action.harness,
        ok: true,
        action,
        status: "skipped",
        message: error.message,
        skipped: true
      };
    }

    return {
      harness: action.harness,
      ok: false,
      action,
      status: "failed",
      message: (error as Error).message
    };
  }
}

function successStatusForOperation(
  operation: InstallOperation | undefined,
  beforeState: InstallTargetState
): InstallStatus {
  if (operation === "install") {
    return beforeState === "different" ? "updated" : "added";
  }
  if (operation === "uninstall") {
    return "removed";
  }
  return "ok";
}

function formatActionMessage(
  action: InstallAction,
  status: InstallStatus,
  fallback?: string
): string {
  if (action.kind === "file-patch") {
    switch (status) {
      case "added":
        return `Installed ${action.filePath}.`;
      case "updated":
        return `Updated ${action.filePath}.`;
      case "already_present":
        return `${action.filePath} is already installed.`;
      case "update_available":
        return `Customized content at ${action.filePath} was preserved.`;
      case "removed":
        return `Removed ${action.filePath}.`;
      case "already_absent":
        return `${action.filePath} is already absent.`;
      default:
        break;
    }
  }
  if (action.kind === "exec" && status === "already_present") {
    return "skill is already installed.";
  }
  return fallback ?? "ok";
}

function isAlreadyPresentMessage(message: string): boolean {
  return /\balready\b.*\b(exists|configured|present|registered|installed)\b/i.test(message);
}

function isAlreadyAbsentMessage(message: string): boolean {
  return /\b(not found|does not exist|not configured|not registered)\b/i.test(message);
}

export function parseHarnessList(values: string[]): HarnessId[] {
  const result: HarnessId[] = [];
  for (const value of values) {
    if (!(SUPPORTED_HARNESSES as readonly string[]).includes(value)) {
      throw new Error(`Unknown harness: ${value}. Supported: ${SUPPORTED_HARNESSES.join(", ")}`);
    }
    if (!result.includes(value as HarnessId)) result.push(value as HarnessId);
  }
  return result;
}

function resolveExecInvocation(
  action: ExecAction,
  resolved: ResolvedOptions
): ExecInvocation | ExecInvocationError | null {
  return resolveCommandInvocation(action.command, action.args, resolved);
}

function resolveCommandInvocation(
  command: string,
  args: string[],
  resolved: ResolvedOptions
): ExecInvocation | ExecInvocationError | null {
  const executable = resolved.hooks.which(command);
  if (!executable) {
    return null;
  }

  if (resolved.platform === "win32" && /\.(cmd|bat)$/i.test(executable)) {
    const unsafeArg = args.find(containsWindowsCmdMetacharacter);
    if (unsafeArg !== undefined) {
      return {
        error:
          `Cannot safely launch ${command} through cmd.exe because ` +
          `an argument contains Windows command metacharacters (& | < > ^ % ").`
      };
    }

    const cmdExe =
      resolved.env.ComSpec?.trim() ||
      resolved.env.COMSPEC?.trim() ||
      "cmd.exe";

    return {
      command: cmdExe,
      args: ["/d", "/s", "/c", executable, ...args],
      options: { windowsHide: true }
    };
  }

  return {
    command: executable,
    args,
    options: resolved.platform === "win32" ? { windowsHide: true } : undefined
  };
}

function formatExecError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }

  return "Failed to launch installer command.";
}

function containsWindowsCmdMetacharacter(value: string): boolean {
  // Node argv quoting does not protect cmd.exe metacharacters for .cmd/.bat.
  return /[&|<>^%"]/.test(value);
}
