import { spawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SUPPORTED_HARNESSES = ["claude-code", "codex", "gemini", "opencode"] as const;
export type HarnessId = (typeof SUPPORTED_HARNESSES)[number];

export const DEFAULT_SERVER_NAME = "talking-stick";
export const DEFAULT_SERVER_COMMAND = ["tt", "mcp"] as const;

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
  serverName?: string;
  serverCommand?: readonly string[];
  skipMissing?: boolean;
}

export interface ExecAction {
  kind: "exec";
  harness: HarnessId;
  command: string;
  args: string[];
  description: string;
  operation?: InstallOperation;
  serverName?: string;
  serverCommand?: readonly string[];
}

export interface FilePatchAction {
  kind: "file-patch";
  harness: HarnessId;
  filePath: string;
  description: string;
  operation?: InstallOperation;
  serverName?: string;
  inspect?: () => InstallTargetState;
  apply: () => void;
}

export interface SkipAction {
  kind: "skip";
  harness: HarnessId;
  description: string;
  message: string;
  operation?: undefined;
  serverName?: undefined;
}

export type InstallAction = ExecAction | FilePatchAction | SkipAction;

export type InstallOperation = "install" | "uninstall";
export type InstallStatus =
  | "added"
  | "already_present"
  | "updated"
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

type InstallTargetState = "absent" | "present" | "different" | "unknown";

interface ResolvedOptions {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homeDir: string;
  serverName: string;
  serverCommand: readonly string[];
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
    serverName: options.serverName ?? DEFAULT_SERVER_NAME,
    serverCommand: options.serverCommand ?? DEFAULT_SERVER_COMMAND,
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
  fs.writeFileSync(filePath, data);
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

function resolveOpencodeConfigDirFromResolved(resolved: ResolvedOptions): string {
  const xdg = resolved.env.XDG_CONFIG_HOME?.trim();
  const base = xdg && xdg.length > 0 ? xdg : path.join(resolved.homeDir, ".config");
  return path.join(base, "opencode");
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
    case "gemini":
      return path.join(resolved.homeDir, ".gemini");
    case "opencode":
      return resolveOpencodeConfigDirFromResolved(resolved);
    default:
      throw new Error(`Unknown harness: ${harness satisfies never}`);
  }
}

export function planInstall(harness: HarnessId, options: InstallOptions = {}): InstallAction {
  const resolved = resolveOptions(options);
  const [serverBin, ...serverArgs] = resolved.serverCommand;
  if (!serverBin) throw new Error("serverCommand must include at least the binary");

  switch (harness) {
    case "claude-code":
      if (resolved.skipMissing && !resolved.hooks.which("claude")) {
        return skipAction(harness, "claude not on PATH");
      }
      return {
        kind: "exec",
        harness,
        command: "claude",
        args: ["mcp", "add", "-s", "user", resolved.serverName, "--", serverBin, ...serverArgs],
        description: `claude mcp add -s user ${resolved.serverName} -- ${resolved.serverCommand.join(" ")}`,
        operation: "install",
        serverName: resolved.serverName,
        serverCommand: resolved.serverCommand
      };
    case "codex":
      if (resolved.skipMissing && !resolved.hooks.which("codex")) {
        return skipAction(harness, "codex not on PATH");
      }
      return {
        kind: "exec",
        harness,
        command: "codex",
        args: ["mcp", "add", resolved.serverName, "--", serverBin, ...serverArgs],
        description: `codex mcp add ${resolved.serverName} -- ${resolved.serverCommand.join(" ")}`,
        operation: "install",
        serverName: resolved.serverName,
        serverCommand: resolved.serverCommand
      };
    case "gemini":
      if (resolved.skipMissing && !resolved.hooks.which("gemini")) {
        return skipAction(harness, "gemini not on PATH");
      }
      return {
        kind: "exec",
        harness,
        command: "gemini",
        args: ["mcp", "add", "-s", "user", "-t", "stdio", resolved.serverName, serverBin, ...serverArgs],
        description: `gemini mcp add -s user -t stdio ${resolved.serverName} ${resolved.serverCommand.join(" ")}`,
        operation: "install",
        serverName: resolved.serverName,
        serverCommand: resolved.serverCommand
      };
    case "opencode": {
      const filePath = resolveOpencodeConfigPath(options);
      const configDir = path.dirname(filePath);
      if (resolved.skipMissing && !resolved.hooks.pathExists(configDir)) {
        return skipAction(harness, `opencode config directory not found: ${configDir}`);
      }
      return {
        kind: "file-patch",
        harness,
        filePath,
        description: `merge mcp.${resolved.serverName} into ${filePath}`,
        operation: "install",
        serverName: resolved.serverName,
        inspect: () => inspectOpencodeConfig(filePath, resolved),
        apply: () => patchOpencodeConfig(filePath, resolved, "install")
      };
    }
    default:
      throw new Error(`Unknown harness: ${harness satisfies never}`);
  }
}

export function planUninstall(harness: HarnessId, options: InstallOptions = {}): InstallAction {
  const resolved = resolveOptions(options);
  switch (harness) {
    case "claude-code":
      if (resolved.skipMissing && !resolved.hooks.which("claude")) {
        return skipAction(harness, "claude not on PATH");
      }
      return {
        kind: "exec",
        harness,
        command: "claude",
        args: ["mcp", "remove", "-s", "user", resolved.serverName],
        description: `claude mcp remove -s user ${resolved.serverName}`,
        operation: "uninstall",
        serverName: resolved.serverName
      };
    case "codex":
      if (resolved.skipMissing && !resolved.hooks.which("codex")) {
        return skipAction(harness, "codex not on PATH");
      }
      return {
        kind: "exec",
        harness,
        command: "codex",
        args: ["mcp", "remove", resolved.serverName],
        description: `codex mcp remove ${resolved.serverName}`,
        operation: "uninstall",
        serverName: resolved.serverName
      };
    case "gemini":
      if (resolved.skipMissing && !resolved.hooks.which("gemini")) {
        return skipAction(harness, "gemini not on PATH");
      }
      return {
        kind: "exec",
        harness,
        command: "gemini",
        args: ["mcp", "remove", "-s", "user", resolved.serverName],
        description: `gemini mcp remove -s user ${resolved.serverName}`,
        operation: "uninstall",
        serverName: resolved.serverName
      };
    case "opencode": {
      const filePath = resolveOpencodeConfigPath(options);
      const configDir = path.dirname(filePath);
      if (resolved.skipMissing && !resolved.hooks.pathExists(configDir)) {
        return skipAction(harness, `opencode config directory not found: ${configDir}`);
      }
      if (resolved.skipMissing && resolved.hooks.readFile(filePath) === null) {
        return skipAction(harness, `opencode config not found: ${filePath}`);
      }
      return {
        kind: "file-patch",
        harness,
        filePath,
        description: `remove mcp.${resolved.serverName} from ${filePath}`,
        operation: "uninstall",
        serverName: resolved.serverName,
        inspect: () => inspectOpencodeConfig(filePath, resolved),
        apply: () => patchOpencodeConfig(filePath, resolved, "uninstall")
      };
    }
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

function patchOpencodeConfig(filePath: string, resolved: ResolvedOptions, mode: "install" | "uninstall"): void {
  const existing = resolved.hooks.readFile(filePath);
  if (resolved.skipMissing) {
    const configDir = path.dirname(filePath);
    if (!resolved.hooks.pathExists(configDir)) {
      throw new MissingHarnessError(`opencode config directory not found: ${configDir}`);
    }
    if (mode === "uninstall" && existing === null) {
      throw new MissingHarnessError(`opencode config not found: ${filePath}`);
    }
  }

  const config: Record<string, unknown> = existing ? parseJsonOrThrow(existing, filePath) : {};
  const mcp = isPlainObject(config.mcp) ? { ...config.mcp } : {};

  if (mode === "install") {
    mcp[resolved.serverName] = {
      type: "local",
      command: [...resolved.serverCommand],
      enabled: true
    };
  } else {
    delete mcp[resolved.serverName];
  }

  config.mcp = mcp;
  resolved.hooks.ensureDir(path.dirname(filePath));
  resolved.hooks.writeFile(filePath, JSON.stringify(config, null, 2) + "\n");
}

function inspectOpencodeConfig(filePath: string, resolved: ResolvedOptions): InstallTargetState {
  const existing = resolved.hooks.readFile(filePath);
  if (existing === null) return "absent";

  let config: Record<string, unknown>;
  try {
    config = parseJsonOrThrow(existing, filePath);
  } catch {
    return "unknown";
  }

  const mcp = isPlainObject(config.mcp) ? config.mcp : {};
  if (!(resolved.serverName in mcp)) return "absent";

  const expected = {
    type: "local",
    command: [...resolved.serverCommand],
    enabled: true
  };
  return valuesEqual(mcp[resolved.serverName], expected) ? "present" : "different";
}

function inspectGeminiSettings(action: ExecAction, resolved: ResolvedOptions): InstallTargetState {
  const filePath = path.join(
    resolveHarnessConfigDirFromResolved("gemini", resolved),
    "settings.json"
  );
  const existing = resolved.hooks.readFile(filePath);
  if (existing === null) return "absent";

  let config: Record<string, unknown>;
  try {
    config = parseJsonOrThrow(existing, filePath);
  } catch {
    return "unknown";
  }

  const servers = isPlainObject(config.mcpServers) ? config.mcpServers : {};
  const serverName = action.serverName ?? resolved.serverName;
  if (!(serverName in servers)) return "absent";

  const [command, ...args] = action.serverCommand ?? resolved.serverCommand;
  const expected = { command, args };
  return valuesEqual(servers[serverName], expected) ? "present" : "different";
}

function parseJsonOrThrow(raw: string, filePath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      throw new Error(`${filePath} is not a JSON object`);
    }
    return parsed;
  } catch (error) {
    throw new Error(`Failed to parse ${filePath} as JSON: ${(error as Error).message}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
    case "gemini": {
      const bin = resolved.hooks.which("gemini");
      if (bin) return { harness, detected: true, evidence: bin };
      const configDir = resolveHarnessConfigDirFromResolved(harness, resolved);
      if (resolved.hooks.pathExists(configDir)) return { harness, detected: true, evidence: configDir };
      return { harness, detected: false, evidence: "gemini not on PATH and no config directory" };
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

    const beforeState = await inspectExecAction(action, resolved);
    if (action.operation === "install" && beforeState === "present") {
      return {
        harness: action.harness,
        ok: true,
        action,
        status: "already_present",
        message: formatMcpActionMessage(action, "already_present")
      };
    }
    if (action.operation === "uninstall" && beforeState === "absent") {
      return {
        harness: action.harness,
        ok: true,
        action,
        status: "already_absent",
        message: formatMcpActionMessage(action, "already_absent")
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
        message: formatMcpActionMessage(action, status, result.stdout.trim() || undefined)
      };
    }

    const errorMessage = result.stderr.trim() || result.stdout.trim() || `${action.command} exited with code ${result.exitCode}`;
    if (action.operation === "install" && isAlreadyPresentMessage(errorMessage)) {
      return {
        harness: action.harness,
        ok: true,
        action,
        status: "already_present",
        message: formatMcpActionMessage(action, "already_present")
      };
    }
    if (action.operation === "uninstall" && isAlreadyAbsentMessage(errorMessage)) {
      return {
        harness: action.harness,
        ok: true,
        action,
        status: "already_absent",
        message: formatMcpActionMessage(action, "already_absent")
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
      message: formatMcpActionMessage(action, "already_present")
    };
  }
  if (action.operation === "uninstall" && beforeState === "absent") {
    return {
      harness: action.harness,
      ok: true,
      action,
      status: "already_absent",
      message: formatMcpActionMessage(action, "already_absent")
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
      message: formatMcpActionMessage(action, status, `Updated ${action.filePath}`)
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

async function inspectExecAction(
  action: ExecAction,
  resolved: ResolvedOptions
): Promise<InstallTargetState> {
  if (!action.operation || !action.serverName) return "unknown";

  if (action.harness === "gemini") {
    return inspectGeminiSettings(action, resolved);
  }

  if (action.harness !== "claude-code" && action.harness !== "codex") {
    return "unknown";
  }

  const invocation = resolveCommandInvocation(
    action.command,
    ["mcp", "get", action.serverName],
    resolved
  );
  if (!invocation || "error" in invocation) return "unknown";

  try {
    const result = await resolved.hooks.run(
      invocation.command,
      invocation.args,
      invocation.options
    );
    return result.exitCode === 0 ? "present" : "absent";
  } catch {
    return "unknown";
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

function formatMcpActionMessage(
  action: InstallAction,
  status: InstallStatus,
  fallback?: string
): string {
  if (!action.serverName || !action.operation) {
    return fallback ?? "ok";
  }

  const target = `MCP server '${action.serverName}'`;
  const location = mcpConfigLocation(action);
  switch (status) {
    case "added":
      return `${target} registered in ${location}.`;
    case "updated":
      return `${target} updated in ${location}.`;
    case "already_present":
      return `${target} already registered in ${location}.`;
    case "removed":
      return `${target} removed from ${location}.`;
    case "already_absent":
      return `${target} is not registered in ${location}.`;
    default:
      return fallback ?? "ok";
  }
}

function mcpConfigLocation(action: InstallAction): string {
  if (action.kind === "file-patch") return action.filePath;
  switch (action.harness) {
    case "claude-code":
      return "Claude Code user config";
    case "codex":
      return "Codex global config";
    case "gemini":
      return "Gemini user config";
    case "opencode":
      return "OpenCode config";
    default:
      return "harness config";
  }
}

function isAlreadyPresentMessage(message: string): boolean {
  return /\balready\b.*\b(exists|configured|present|registered|installed)\b/i.test(message);
}

function isAlreadyAbsentMessage(message: string): boolean {
  return /\b(not found|does not exist|not configured|not registered|no mcp server)\b/i.test(message);
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
