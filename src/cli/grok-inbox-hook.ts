import DatabaseConstructor from "better-sqlite3";
import { resolveDatabasePath, type SqliteDatabase } from "../db.js";
import { TalkingStickService } from "../service.js";

export interface GrokInboxHookOptions {
  stdin?: string;
  service?: TalkingStickService;
  stdout?: (text: string) => void;
}

// Hook output is deliberately JSON only. Fail open on every malformed input,
// lookup or database failure; hooks must never break a tool or trap a session.
export async function runGrokInboxHookCommand(options: GrokInboxHookOptions = {}): Promise<void> {
  let service: TalkingStickService | undefined;
  let hookDatabase: SqliteDatabase | undefined;
  try {
    let raw = options.stdin;
    if (raw === undefined) {
      raw = "";
      for await (const chunk of process.stdin) raw += chunk.toString();
    }
    const input = JSON.parse(raw) as Record<string, unknown>;
    if (!input || typeof input !== "object" || Array.isArray(input)) return;
    const event = typeof input.hookEventName === "string" ? input.hookEventName.replace(/_/g, "").toLowerCase() : "";
    if (!["posttooluse", "posttoolusefailure", "stop"].includes(event) || input.subagentType || input.subagent_type) return;
    if (event === "stop" && (input.reason !== "end_turn" || input.stopHookActive === true || input.stop_hook_active === true)) return;
    const session = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
    const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
    if (!session || !cwd) return;
    if (!options.service) {
      // Hooks never create or migrate state. Joining/installing through the CLI
      // owns that work; an absent or older database simply fails open.
      hookDatabase = new DatabaseConstructor(resolveDatabasePath(), { fileMustExist: true, timeout: 1000 });
      hookDatabase.pragma("foreign_keys = ON");
    }
    service = options.service ?? new TalkingStickService({ db: hookDatabase });
    const text = service.prepareGrokHookDelivery({ context_path: cwd, harness_session_id: `harness:${session}`,
      diagnostic: text => process.stderr.write(text + "\n") });
    if (!text) return;
    const hookEventName = event === "stop" ? "Stop" : event === "posttoolusefailure" ? "PostToolUseFailure" : "PostToolUse";
    const result = { hookSpecificOutput: { hookEventName, additionalContext: text } };
    (options.stdout ?? (value => process.stdout.write(value)))(JSON.stringify(result) + "\n");
  } catch {
    // Pending events remain durable and can still be received through tt wait.
  } finally {
    try { hookDatabase?.close(); } catch { /* fail open */ }
  }
}
