import { TalkingStickService } from "../service.js";
import { findHarnessRootInAncestry } from "../identity.js";
import { createSystemProcessInspector, type ProcessInspector } from "../process-utils.js";

export async function runSessionHookCommand(harness: string | undefined, options: {
  stdin?: string; service?: TalkingStickService; inspector?: ProcessInspector; parentPid?: number;
} = {}): Promise<void> {
  let service: TalkingStickService | undefined;
  try {
    if (harness !== "claude" && harness !== "codex" && harness !== "grok") return;
    let raw = options.stdin;
    if (raw === undefined) {
      raw = "";
      for await (const chunk of process.stdin) raw += chunk;
    }
    const input = JSON.parse(raw) as Record<string, unknown>;
    if (!input || typeof input !== "object" || Array.isArray(input)) return;
    const rawEvent = input.hook_event_name ?? input.hookEventName;
    const normalizedEvent = typeof rawEvent === "string" ? rawEvent.toLowerCase().replace(/[^a-z0-9]/g, "") : "";
    const event = normalizedEvent === "sessionstart" ? "SessionStart"
      : normalizedEvent === "sessionend" ? "SessionEnd" : null;
    const sessionId = input.session_id ?? input.sessionId;
    if (!event ||
        typeof sessionId !== "string" || !sessionId.trim()) return;
    // Some harness hook payloads identify the parent when a child runs a hook.
    if (input.subagent_type || input.subagentType || input.agent_id || input.agentId) return;
    const inspector = options.inspector ?? createSystemProcessInspector();
    const parentPid = options.parentPid ?? process.ppid;
    const root = findHarnessRootInAncestry(harness, parentPid, inspector.inspect(parentPid), inspector, 20);
    if (!root) return;
    service = options.service ?? new TalkingStickService({});
    service.recordSessionLifecycle({ harness, sessionId: sessionId.trim(), event,
      pid: root.pid, processStartedAt: root.startTime });
  } catch {
    // A lifecycle hook must never prevent a clear, resume, or exit.
  } finally {
    if (service && !options.service) {
      try { service.close(); } catch { /* fail open */ }
    }
  }
}
