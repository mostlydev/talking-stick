import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  createSystemProcessInspector,
  type ProcessInspection,
  type ProcessInspector
} from "./process-utils.js";
import type { ProcessMetadata, SessionKind } from "./types.js";

export interface DerivedIdentity {
  agent_id: string;
  process_metadata: ProcessMetadata;
}

export interface DeriveHumanCliIdentityOptions {
  agentId?: string;
  username?: string;
  pid?: number;
  hostId?: string;
  inspector?: ProcessInspector;
  displayName?: string;
  sessionKind?: SessionKind;
}

export interface DeriveMcpHarnessIdentityOptions {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  parentPid?: number;
  sessionId?: string;
  hostId?: string;
  username?: string;
  inspector?: ProcessInspector;
  displayName?: string;
}

export interface DeriveHarnessCliIdentityOptions {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  username?: string;
  parentPid?: number;
  hostId?: string;
  inspector?: ProcessInspector;
  displayName?: string;
}

export type HarnessCliHarness = "claude" | "codex" | "gemini" | "opencode";

interface HarnessSignal {
  harness: HarnessCliHarness;
  sessionId: string | null;
  pidHint: number | null;
}

const HARNESS_CLI_EXPORT_ENV = "TT_HARNESS_EXPORT";
const HARNESS_CLI_AGENT_ID_ENV = "TT_HARNESS_AGENT_ID";

export function deriveHumanCliIdentity(
  options: DeriveHumanCliIdentityOptions = {}
): DerivedIdentity {
  const username = options.username ?? safeUsername();
  const displayName = options.displayName ?? username;
  const agentId =
    options.agentId ?? `human:${sanitizeIdentityComponent(username)}`;
  const sessionKind = options.sessionKind ?? "human_cli";
  const includesExactProcessIdentity = sessionKind === "human_guardian";

  let hostId: string | null = null;
  let pid: number | null = null;
  let processStartedAt: string | null = null;

  if (includesExactProcessIdentity) {
    const inspector = options.inspector ?? createSystemProcessInspector();
    pid = options.pid ?? process.pid;
    const inspection = inspector.inspect(pid);
    hostId = options.hostId ?? os.hostname();
    processStartedAt = inspection?.startTime ?? null;
  }

  return {
    agent_id: agentId,
    process_metadata: {
      host_id: hostId,
      pid,
      process_started_at: processStartedAt,
      session_kind: sessionKind,
      display_name: displayName
    }
  };
}

export function deriveMcpHarnessIdentity(
  options: DeriveMcpHarnessIdentityOptions = {}
): DerivedIdentity {
  const env = options.env ?? process.env;
  const inspector = options.inspector ?? createSystemProcessInspector();
  const parentPid = options.parentPid ?? process.ppid;
  const hostId = options.hostId ?? os.hostname();
  const username = options.username ?? safeUsername();
  const parentInspection = inspector.inspect(parentPid);

  const signal = detectHarnessSignal(env);
  if (signal) {
    const processRef = resolveSignalProcessRef(
      signal,
      parentPid,
      parentInspection,
      inspector
    );
    const sessionId = resolveHarnessSessionId(
      signal,
      env,
      processRef.pid,
      processRef.inspection,
      username,
      hostId
    );
    const agentId =
      options.agentId ?? harnessAgentId(signal.harness, sessionId, hostId, username);
    return {
      agent_id: agentId,
      process_metadata: {
        host_id: hostId,
        pid: processRef.pid,
        process_started_at: processRef.inspection?.startTime ?? null,
        session_kind: "mcp_harness",
        display_name: signal.harness
      }
    };
  }

  const displayName =
    options.displayName ?? deriveCommandLabel(parentInspection?.command ?? null);
  const agentId =
    options.agentId ??
    `${sanitizeIdentityComponent(displayName)}:${hashIdentityParts([
      hostId,
      String(parentPid),
      parentInspection?.startTime ?? "",
      options.sessionId ?? ""
    ])}`;

  return {
    agent_id: agentId,
    process_metadata: {
      host_id: hostId,
      pid: parentPid,
      process_started_at: parentInspection?.startTime ?? null,
      session_kind: "mcp_harness",
      display_name: displayName
    }
  };
}

export function deriveHarnessCliIdentity(
  options: DeriveHarnessCliIdentityOptions = {}
): DerivedIdentity | null {
  const env = options.env ?? process.env;
  const inspector = options.inspector ?? createSystemProcessInspector();
  const exportedAgentId = nonEmpty(env[HARNESS_CLI_AGENT_ID_ENV]);
  const parentPid = options.parentPid ?? process.ppid;
  const hostId = options.hostId ?? os.hostname();
  const parentInspection = inspector.inspect(parentPid);

  if (exportedAgentId) {
    return {
      agent_id: options.agentId ?? exportedAgentId,
      process_metadata: {
        host_id: hostId,
        pid: parentPid,
        process_started_at: parentInspection?.startTime ?? null,
        session_kind: "harness_cli",
        display_name:
          options.displayName ?? deriveHarnessDisplayName(exportedAgentId)
      }
    };
  }

  let signal = detectHarnessSignal(env);

  if (!signal && !isHarnessCliExportEnabled(env)) {
    return null;
  }

  if (!signal) {
    signal = detectHarnessViaAncestry(parentPid, inspector);
  }

  if (!signal) return null;

  const processRef = resolveSignalProcessRef(
    signal,
    parentPid,
    parentInspection,
    inspector
  );
  const username = options.username ?? safeUsername();
  const sessionId = resolveHarnessSessionId(
    signal,
    env,
    processRef.pid,
    processRef.inspection,
    username,
    hostId
  );

  const agentId =
    options.agentId ?? harnessAgentId(signal.harness, sessionId, hostId, username);

  return {
    agent_id: agentId,
    process_metadata: {
      host_id: hostId,
      pid: processRef.pid,
      process_started_at: processRef.inspection?.startTime ?? null,
      session_kind: "harness_cli",
      display_name: options.displayName ?? signal.harness
    }
  };
}

function harnessAgentId(
  harness: HarnessCliHarness,
  sessionId: string,
  hostId: string,
  username: string
): string {
  return `${harness}:${hashIdentityParts([
    harness,
    hostId,
    sessionId,
    sanitizeIdentityComponent(username)
  ])}`;
}

function resolveHarnessSessionId(
  signal: HarnessSignal,
  env: NodeJS.ProcessEnv,
  parentPid: number,
  parentInspection: ProcessInspection | null | undefined,
  username: string,
  hostId: string
): string {
  if (signal.sessionId) return `harness:${signal.sessionId}`;
  const terminalId = resolveTerminalSessionId(env);
  if (terminalId) return terminalId;
  if (parentInspection?.startTime) {
    return `pid:${parentPid}@${parentInspection.startTime}`;
  }
  return `userhost:${sanitizeIdentityComponent(username)}@${hostId}`;
}

const TERMINAL_SESSION_ENV_VARS = [
  "ITERM_SESSION_ID",
  "CMUX_TAB_ID",
  "KITTY_WINDOW_ID",
  "WEZTERM_PANE",
  "TERMINATOR_UUID",
  "TMUX_PANE",
  "STY"
] as const;

function resolveTerminalSessionId(env: NodeJS.ProcessEnv): string | null {
  for (const key of TERMINAL_SESSION_ENV_VARS) {
    const value = env[key];
    if (value && value.trim().length > 0) {
      return `term:${key}=${value.trim()}`;
    }
  }
  return null;
}

function isHarnessCliExportEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env[HARNESS_CLI_EXPORT_ENV];
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true";
}

function deriveHarnessDisplayName(agentId: string): string {
  const prefix = agentId.split(":")[0]?.trim();
  return prefix && prefix.length > 0 ? prefix : "harness";
}

const HARNESS_COMMAND_MAPPING: Record<string, HarnessCliHarness> = {
  claude: "claude",
  "claude-code": "claude",
  codex: "codex",
  gemini: "gemini",
  opencode: "opencode"
};

function detectHarnessViaAncestry(
  pid: number,
  inspector: ProcessInspector,
  maxDepth = 10
): HarnessSignal | null {
  let currentPid: number | null = pid;
  for (let i = 0; i < maxDepth; i++) {
    if (currentPid === null || currentPid === 0 || currentPid === 1) break;
    const inspection = inspector.inspect(currentPid);
    if (!inspection) break;

    const label = deriveCommandLabel(inspection.command);
    if (HARNESS_COMMAND_MAPPING[label]) {
      return {
        harness: HARNESS_COMMAND_MAPPING[label],
        sessionId: `pid:${inspection.pid}@${inspection.startTime}`,
        pidHint: null
      };
    }

    currentPid = inspection.ppid;
  }
  return null;
}

function detectHarnessSignal(env: NodeJS.ProcessEnv): HarnessSignal | null {
  if (env.CLAUDECODE === "1") {
    return {
      harness: "claude",
      sessionId: null,
      pidHint: parsePositiveInteger(env.CMUX_CLAUDE_PID)
    };
  }
  if (env.CODEX_MANAGED_BY_NPM === "1" || nonEmpty(env.CODEX_THREAD_ID)) {
    return {
      harness: "codex",
      sessionId: nonEmpty(env.CODEX_THREAD_ID),
      pidHint: null
    };
  }
  if (env.GEMINI_CLI === "1") {
    return { harness: "gemini", sessionId: null, pidHint: null };
  }
  if (env.OPENCODE === "1") {
    return {
      harness: "opencode",
      sessionId: nonEmpty(env.OPENCODE_RUN_ID) ?? nonEmpty(env.OPENCODE_PID),
      pidHint: null
    };
  }
  return null;
}

function resolveSignalProcessRef(
  signal: HarnessSignal,
  fallbackPid: number,
  fallbackInspection: ProcessInspection | null | undefined,
  inspector: ProcessInspector
): {
  pid: number;
  inspection: ProcessInspection | null | undefined;
} {
  if (signal.pidHint && signal.pidHint !== fallbackPid) {
    const hintedInspection = inspector.inspect(signal.pidHint);
    if (hintedInspection?.startTime) {
      return {
        pid: signal.pidHint,
        inspection: hintedInspection
      };
    }
  }

  return {
    pid: fallbackPid,
    inspection: fallbackInspection
  };
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value.trim())) {
    return null;
  }

  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonEmpty(value: string | undefined): string | null {
  return value && value.trim().length > 0 ? value : null;
}

function deriveCommandLabel(command: string | null): string {
  if (!command) {
    return "harness";
  }

  const token = command.trim().split(/\s+/)[0] ?? "";
  const basename = path.basename(token).replace(/\.(exe|cmd|bat)$/i, "");
  const sanitized = sanitizeIdentityComponent(basename);
  return sanitized || "harness";
}

function safeUsername(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER ?? process.env.LOGNAME ?? "user";
  }
}

function sanitizeIdentityComponent(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "anon";
}

function hashIdentityParts(parts: string[]): string {
  return crypto
    .createHash("sha256")
    .update(parts.join("\0"))
    .digest("hex")
    .slice(0, 8);
}
