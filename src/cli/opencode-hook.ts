import path from "node:path";
import { resolveDatabasePath } from "../db.js";
import { findHarnessRootInAncestry } from "../identity.js";
import { createSystemProcessInspector, type ProcessInspector } from "../process-utils.js";
import { TalkingStickService } from "../service.js";
import { openSqlite, type SqliteDatabase } from "../sqlite.js";

export async function runOpencodeHookCommand(event: string | undefined, options: {
  stdin?: string; service?: TalkingStickService; inspector?: ProcessInspector;
  parentPid?: number; stdout?: (text: string) => void;
} = {}): Promise<void> {
  let db: SqliteDatabase | undefined;
  try {
    if (event !== "start" && event !== "end" && event !== "delivery") return;
    let raw = options.stdin;
    if (raw === undefined) {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of process.stdin) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 16_384) return;
        chunks.push(buffer);
      }
      raw = Buffer.concat(chunks).toString("utf8");
    }
    const input = JSON.parse(raw) as Record<string, unknown>;
    if (typeof input?.session_id !== "string" || !input.session_id.trim() ||
        typeof input.cwd !== "string" || !path.isAbsolute(input.cwd)) return;
    const inspector = options.inspector ?? createSystemProcessInspector();
    const parent = options.parentPid ?? process.ppid;
    const root = findHarnessRootInAncestry("opencode", parent, inspector.inspect(parent), inspector, 20,
      Boolean(process.env.TT_SUPERVISOR_ENDPOINT && process.env.TT_SUPERVISOR_TOKEN));
    if (!root?.startTime) return;
    if (!options.service) {
      db = openSqlite(resolveDatabasePath(), { fileMustExist: true, timeout: 1_000 });
      db.pragma("foreign_keys = ON");
    }
    const service = options.service ?? new TalkingStickService({ db });
    const sessionId = input.session_id.trim();
    if (event === "delivery") {
      const text = service.prepareHarnessHookDelivery({
        harness: "opencode", context_path: input.cwd, harness_session_id: `harness:${sessionId}`,
        pid: root.pid, processStartedAt: root.startTime
      });
      if (text) (options.stdout ?? (value => process.stdout.write(value)))(text + "\n");
      return;
    }
    service.recordSessionLifecycle({
      harness: "opencode", sessionId, pid: root.pid, processStartedAt: root.startTime,
      event: event === "start" ? "SessionStart" : "SessionEnd", processKind: "shared_host"
    });
  } catch {
    // A hook never prevents an OpenCode session from running.
  } finally {
    try { db?.close(); } catch { /* fail open */ }
  }
}
