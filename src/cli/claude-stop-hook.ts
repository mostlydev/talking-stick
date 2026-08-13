import { TalkingStickService } from "../service.js";

interface ClaudeStopHookInput {
  session_id?: unknown;
  cwd?: unknown;
  stop_hook_active?: unknown;
  hook_event_name?: unknown;
}

export interface RunClaudeStopHookOptions {
  stdin?: string;
  cwd?: string;
  service?: TalkingStickService;
  stderr?: (text: string) => void;
  setExitCode?: (code: number) => void;
}

// Claude Code Stop-hook entry point. Exit code 2 blocks the stop and surfaces
// stderr to the model; anything else lets the stop proceed. Every failure path
// must fail open (exit 0): coordination being unavailable must never trap a
// session at its prompt.
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
    if (input.stop_hook_active === true) {
      return;
    }
    const sessionId = nonEmptyString(input.session_id);
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
