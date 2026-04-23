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
  which?: (binary: string) => string | null;
}

export interface InstallOptions extends Partial<InstallEnv>, InstallerHooks {
  serverName?: string;
  serverCommand?: readonly string[];
}

export interface ExecAction {
  kind: "exec";
  harness: HarnessId;
  command: string;
  args: string[];
  description: string;
}

export interface FilePatchAction {
  kind: "file-patch";
  harness: HarnessId;
  filePath: string;
  description: string;
  apply: () => void;
}

export type InstallAction = ExecAction | FilePatchAction;

export interface InstallResult {
  harness: HarnessId;
  ok: boolean;
  action: InstallAction;
  message: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ResolvedOptions {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homeDir: string;
  serverName: string;
  serverCommand: readonly string[];
  hooks: Required<InstallerHooks>;
}

function resolveOptions(options: InstallOptions = {}): ResolvedOptions {
  return {
    env: options.env ?? process.env,
    platform: options.platform ?? process.platform,
    homeDir: options.homeDir ?? os.homedir(),
    serverName: options.serverName ?? DEFAULT_SERVER_NAME,
    serverCommand: options.serverCommand ?? DEFAULT_SERVER_COMMAND,
    hooks: {
      run: options.run ?? defaultRun,
      readFile: options.readFile ?? defaultReadFile,
      writeFile: options.writeFile ?? defaultWriteFile,
      ensureDir: options.ensureDir ?? defaultEnsureDir,
      which: options.which ?? defaultWhich
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

function defaultWhich(binary: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  const separator = process.platform === "win32" ? ";" : ":";
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
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
  const resolved = resolveOptions(options);
  const xdg = resolved.env.XDG_CONFIG_HOME?.trim();
  const base = xdg && xdg.length > 0 ? xdg : path.join(resolved.homeDir, ".config");
  return path.join(base, "opencode", "opencode.json");
}

export function planInstall(harness: HarnessId, options: InstallOptions = {}): InstallAction {
  const resolved = resolveOptions(options);
  const [serverBin, ...serverArgs] = resolved.serverCommand;
  if (!serverBin) throw new Error("serverCommand must include at least the binary");

  switch (harness) {
    case "claude-code":
      return {
        kind: "exec",
        harness,
        command: "claude",
        args: ["mcp", "add", "-s", "user", resolved.serverName, "--", serverBin, ...serverArgs],
        description: `claude mcp add -s user ${resolved.serverName} -- ${resolved.serverCommand.join(" ")}`
      };
    case "codex":
      return {
        kind: "exec",
        harness,
        command: "codex",
        args: ["mcp", "add", resolved.serverName, "--", serverBin, ...serverArgs],
        description: `codex mcp add ${resolved.serverName} -- ${resolved.serverCommand.join(" ")}`
      };
    case "gemini":
      return {
        kind: "exec",
        harness,
        command: "gemini",
        args: ["mcp", "add", "-s", "user", "-t", "stdio", resolved.serverName, serverBin, ...serverArgs],
        description: `gemini mcp add -s user -t stdio ${resolved.serverName} ${resolved.serverCommand.join(" ")}`
      };
    case "opencode": {
      const filePath = resolveOpencodeConfigPath(options);
      return {
        kind: "file-patch",
        harness,
        filePath,
        description: `merge mcp.${resolved.serverName} into ${filePath}`,
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
      return {
        kind: "exec",
        harness,
        command: "claude",
        args: ["mcp", "remove", "-s", "user", resolved.serverName],
        description: `claude mcp remove -s user ${resolved.serverName}`
      };
    case "codex":
      return {
        kind: "exec",
        harness,
        command: "codex",
        args: ["mcp", "remove", resolved.serverName],
        description: `codex mcp remove ${resolved.serverName}`
      };
    case "gemini":
      return {
        kind: "exec",
        harness,
        command: "gemini",
        args: ["mcp", "remove", "-s", "user", resolved.serverName],
        description: `gemini mcp remove -s user ${resolved.serverName}`
      };
    case "opencode": {
      const filePath = resolveOpencodeConfigPath(options);
      return {
        kind: "file-patch",
        harness,
        filePath,
        description: `remove mcp.${resolved.serverName} from ${filePath}`,
        apply: () => patchOpencodeConfig(filePath, resolved, "uninstall")
      };
    }
    default:
      throw new Error(`Unknown harness: ${harness satisfies never}`);
  }
}

function patchOpencodeConfig(filePath: string, resolved: ResolvedOptions, mode: "install" | "uninstall"): void {
  const existing = resolved.hooks.readFile(filePath);
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
      return { harness, detected: bin !== null, evidence: bin ?? "claude not on PATH" };
    }
    case "codex": {
      const bin = resolved.hooks.which("codex");
      return { harness, detected: bin !== null, evidence: bin ?? "codex not on PATH" };
    }
    case "gemini": {
      const bin = resolved.hooks.which("gemini");
      return { harness, detected: bin !== null, evidence: bin ?? "gemini not on PATH" };
    }
    case "opencode": {
      const bin = resolved.hooks.which("opencode");
      if (bin) return { harness, detected: true, evidence: bin };
      const configPath = resolveOpencodeConfigPath(options);
      const existing = resolved.hooks.readFile(configPath);
      if (existing !== null) return { harness, detected: true, evidence: configPath };
      return { harness, detected: false, evidence: "opencode not on PATH and no config file" };
    }
    default:
      throw new Error(`Unknown harness: ${harness satisfies never}`);
  }
}

export async function runAction(action: InstallAction, options: InstallOptions = {}): Promise<InstallResult> {
  const resolved = resolveOptions(options);
  if (action.kind === "exec") {
    const result = await resolved.hooks.run(action.command, action.args);
    if (result.exitCode === 0) {
      return {
        harness: action.harness,
        ok: true,
        action,
        message: result.stdout.trim() || `${action.command} succeeded`
      };
    }
    return {
      harness: action.harness,
      ok: false,
      action,
      message: (result.stderr.trim() || result.stdout.trim() || `${action.command} exited with code ${result.exitCode}`)
    };
  }

  try {
    action.apply();
    return {
      harness: action.harness,
      ok: true,
      action,
      message: `Updated ${action.filePath}`
    };
  } catch (error) {
    return {
      harness: action.harness,
      ok: false,
      action,
      message: (error as Error).message
    };
  }
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
