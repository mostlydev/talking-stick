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
  parentPid?: number;
  sessionId?: string;
  hostId?: string;
  inspector?: ProcessInspector;
  displayName?: string;
}

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
  const inspector = options.inspector ?? createSystemProcessInspector();
  const pid = options.parentPid ?? process.ppid;
  const hostId = options.hostId ?? os.hostname();
  const inspection = inspector.inspect(pid);
  const displayName =
    options.displayName ?? deriveCommandLabel(inspection?.command ?? null);
  const agentId =
    options.agentId ??
    `${sanitizeIdentityComponent(displayName)}:${hashIdentityParts([
      hostId,
      String(pid),
      inspection?.startTime ?? "",
      options.sessionId ?? ""
    ])}`;

  return {
    agent_id: agentId,
    process_metadata: {
      host_id: hostId,
      pid,
      process_started_at: inspection?.startTime ?? null,
      session_kind: "mcp_harness",
      display_name: displayName
    }
  };
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
