import { resolveDatabasePath } from "../db.js";
import { findHarnessRootInAncestry } from "../identity.js";
import { createSystemProcessInspector, type ProcessInspector } from "../process-utils.js";
import { TalkingStickService } from "../service.js";
import { openSqlite, type SqliteDatabase } from "../sqlite.js";

export async function runAntigravityHookCommand(event: string | undefined, options: {
  stdin?: string; service?: TalkingStickService; inspector?: ProcessInspector;
  parentPid?: number; stdout?: (text: string) => void;
} = {}): Promise<void> {
  let db: SqliteDatabase | undefined;
  try {
    if (event !== "SessionStart" && event !== "PreInvocation" && event !== "Stop") return;
    let raw = options.stdin;
    if (raw === undefined) {
      raw = "";
      for await (const chunk of process.stdin) raw += chunk.toString();
    }
    const input = JSON.parse(raw) as Record<string, unknown>;
    if (!input || typeof input.conversationId !== "string" || !input.conversationId.trim()) return;
    // A completed turn is not a closed conversation. Continue only at a
    // normal turn boundary, never on cancel, error, or active background work.
    if (event === "Stop" && (input.fullyIdle !== true || input.continuationActive === true ||
        (input.terminationReason !== "NO_TOOL_CALL" && input.terminationReason !== "model_stop"))) return;
    const inspector = options.inspector ?? createSystemProcessInspector();
    const parent = options.parentPid ?? process.ppid;
    const root = findHarnessRootInAncestry("antigravity", parent, inspector.inspect(parent), inspector, 20);
    if (!root?.startTime) return;
    if (!options.service) {
      db = openSqlite(resolveDatabasePath(), { fileMustExist: true, timeout: 1_000 });
      db.pragma("foreign_keys = ON");
    }
    const service = options.service ?? new TalkingStickService({ db });
    const sessionId = input.conversationId.trim();
    if (event === "SessionStart") {
      service.recordSessionLifecycle({ harness: "antigravity", sessionId, pid: root.pid,
        processStartedAt: root.startTime, event, processKind: "shared_host" });
      return;
    }
    const workspaces = Array.isArray(input.workspacePaths) ? input.workspacePaths : [];
    for (const workspace of new Set([input.cwd, ...workspaces])) {
      if (typeof workspace !== "string" || !workspace.trim()) continue;
      const text = service.prepareHarnessHookDelivery({ harness: "antigravity", context_path: workspace,
        harness_session_id: `harness:${sessionId}`, pid: root.pid, processStartedAt: root.startTime });
      if (!text) continue;
      const output = event === "Stop" ? { decision: "continue", reason: text }
        : { injectSteps: [{ systemMessage: { systemMessage: text } }] };
      (options.stdout ?? (value => process.stdout.write(value)))(JSON.stringify(output) + "\n");
      break;
    }
  } catch {
    // Events survive a failed hook or stdout write and remain readable via tt wait.
  } finally {
    try { db?.close(); } catch { /* fail open */ }
  }
}
