import {
  createSystemProcessInspector,
  type ProcessInspector
} from "../process-utils.js";
import {
  appendGrokSessionRecord,
  type GrokSessionRecord
} from "../grok-session-store.js";
import { findHarnessRootInAncestry } from "../identity.js";

interface GrokHookInput {
  hookEventName?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  workspaceRoot?: unknown;
  timestamp?: unknown;
}

export interface RunGrokSessionHookOptions {
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  now?: Date;
  parentPid?: number;
  inspector?: ProcessInspector;
  logPath?: string;
}

export async function runGrokSessionHookCommand(
  options: RunGrokSessionHookOptions = {}
): Promise<void> {
  try {
    const env = options.env ?? process.env;
    const input = parseHookInput(options.stdin ?? await readStdin());
    const sessionId = firstNonEmptyString(
      env.GROK_SESSION_ID,
      input.sessionId
    );
    const workspaceRoot = firstNonEmptyString(
      env.GROK_WORKSPACE_ROOT,
      env.CLAUDE_PROJECT_DIR,
      input.workspaceRoot
    );
    if (!sessionId || !workspaceRoot) {
      return;
    }

    const event = firstNonEmptyString(
      env.GROK_HOOK_EVENT,
      input.hookEventName
    ) ?? "unknown";
    const inspector = options.inspector ?? createSystemProcessInspector();
    const parentPid = options.parentPid ?? process.ppid;
    const parentInspection = inspector.inspect(parentPid);
    const grokRoot = findHarnessRootInAncestry(
      "grok",
      parentPid,
      parentInspection,
      inspector,
      20
    );

    const record: GrokSessionRecord = {
      source: "grok_hook",
      grok_session_id: sessionId,
      workspace_root: workspaceRoot,
      cwd: firstNonEmptyString(input.cwd),
      event,
      observed_at:
        firstNonEmptyString(input.timestamp) ??
        (options.now ?? new Date()).toISOString(),
      grok_pid: grokRoot?.pid ?? null,
      grok_process_started_at: grokRoot?.startTime ?? null
    };
    appendGrokSessionRecord(record, { logPath: options.logPath });
  } catch {
    // Grok hooks must fail open. Identity can fall back to pid-root detection
    // when the hook cannot record a session row.
  }
}

function parseHookInput(raw: string): GrokHookInput {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isObjectRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(raw));
  });
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
