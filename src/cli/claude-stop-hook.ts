import { TalkingStickService } from "../service.js";

// Grok loads ~/.claude/settings.json for Claude compatibility and sends the
// same events with camelCase keys, so every field is read in both spellings.
interface ClaudeStopHookInput {
  session_id?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  stop_hook_active?: unknown;
  stopHookActive?: unknown;
  hook_event_name?: unknown;
  hookEventName?: unknown;
  reason?: unknown;
  subagentType?: unknown;
  subagent_type?: unknown;
}

export interface RunClaudeStopHookOptions {
  stdin?: string;
  cwd?: string;
  service?: TalkingStickService;
  stderr?: (text: string) => void;
  setExitCode?: (code: number) => void;
}

export async function runClaudeStopHookCommand(
  options: RunClaudeStopHookOptions = {}
): Promise<void> {
  const writeStderr =
    options.stderr ?? ((text: string) => process.stderr.write(text));
  const setExitCode =
    options.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });

  let service: TalkingStickService | null = null;
  const ownsService = !options.service;
  try {
    const input = parseHookInput(options.stdin ?? (await readStdin()));
    if (input.stop_hook_active === true || input.stopHookActive === true) {
      return;
    }
    // Grok fires Stop for a session ending too, and separately for a subagent.
    // Only an ordinary turn end is a moment where handing off makes sense;
    // blocking the others would trap a teardown or a child that owns nothing.
    // Grok always names its reason, so a Grok payload must say end_turn; Claude
    // sends no reason at all and is recognised by that absence.
    const reason = nonEmptyString(input.reason);
    const fromGrok = nonEmptyString(input.hookEventName) !== null;
    if (fromGrok ? reason !== "end_turn" : reason !== null && reason !== "end_turn") {
      return;
    }
    const event = nonEmptyString(input.hook_event_name) ?? nonEmptyString(input.hookEventName);
    if (
      (event && /subagent/i.test(event)) ||
      nonEmptyString(input.subagentType) ||
      nonEmptyString(input.subagent_type)
    ) {
      return;
    }
    const sessionId =
      nonEmptyString(input.session_id) ?? nonEmptyString(input.sessionId);
    if (!sessionId) {
      return;
    }
    const contextPath =
      nonEmptyString(input.cwd) ?? options.cwd ?? process.cwd();

    service = options.service ?? new TalkingStickService({});
    const inspection = service.inspectStopGuard({
      context_path: contextPath,
      harness_session_id: `harness:${sessionId}`
    });
    if (!inspection.blocked) {
      return;
    }

    const grant =
      inspection.reason === "owner"
        ? `holds the Talking Stick turn (turn ${inspection.turn_id})`
        : `has an unclaimed Talking Stick reservation (turn ${inspection.turn_id})`;
    writeStderr(
      `This session's agent ${inspection.agent_id} still ${grant} in ${inspection.canonical_path}. ` +
        `Finish the work, then hand off with \`tt release --stdin\` or \`tt pass\` before stopping.\n`
    );
    setExitCode(2);
  } catch {
    // Fail open: never block a stop because coordination state is unreadable.
  } finally {
    if (ownsService && service) {
      try {
        service.close();
      } catch {
        // Ignore close failures on the fail-open path.
      }
    }
  }
}

function parseHookInput(raw: string): ClaudeStopHookInput {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isObjectRecord(parsed) ? (parsed as ClaudeStopHookInput) : {};
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

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
