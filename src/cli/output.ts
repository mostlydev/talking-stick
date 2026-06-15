import { SUPPORTED_HARNESSES } from "../install.js";
import type { Handoff } from "../index.js";
import { isKnownHarnessCliEnv } from "./identity.js";
import { hasOption, type ParsedCommand } from "./parser.js";

export const COORDINATION_PROMPT =
  "Keep `tt wait` or `tt events` active until all goals are met; re-read the Talking Stick skill if context slips.";

const COORDINATION_PROMPT_COMMANDS = new Set([
  "join",
  "state",
  "events",
  "wait",
  "try",
  "take",
  "takeover",
  "release",
  "pass",
  "assign",
  "msg send"
]);

export function printResult(
  parsed: ParsedCommand,
  result: unknown,
  renderText: () => string
): void {
  if (shouldUseJson(parsed)) {
    process.stdout.write(
      `${JSON.stringify(withCoordinationPrompt(parsed, result), null, 2)}\n`
    );
    return;
  }

  process.stdout.write(`${renderText()}\n`);
}

export function shouldUseJson(
  parsed: ParsedCommand,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (hasOption(parsed, "json")) return true;
  if (hasOption(parsed, "text")) return false;
  // Auto-JSON when invoked from a harness, using the same detection as
  // identity resolution. TT_HARNESS_EXPORT remains an explicit opt-in for
  // ancestry-only detection where no harness env marker is present.
  const exportFlag = env.TT_HARNESS_EXPORT;
  if (exportFlag === "1" || exportFlag?.toLowerCase() === "true") return true;
  if (isKnownHarnessCliEnv(env)) return true;
  return false;
}

export function withCoordinationPrompt(
  parsed: ParsedCommand,
  result: unknown
): unknown {
  if (!COORDINATION_PROMPT_COMMANDS.has(parsed.name)) {
    return result;
  }
  if (!isObjectRecord(result) || Array.isArray(result)) {
    return result;
  }
  if ("coordination_prompt" in result) {
    return result;
  }
  return {
    ...result,
    coordination_prompt: COORDINATION_PROMPT
  };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function formatRelativeTime(
  iso: string | null | undefined,
  now: Date = new Date()
): string {
  if (!iso) return "—";
  const target = Date.parse(iso);
  if (Number.isNaN(target)) return iso;
  const deltaMs = target - now.getTime();
  const absMs = Math.abs(deltaMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  let value: string;
  if (absMs < minute) value = `${Math.max(1, Math.round(absMs / 1000))}s`;
  else if (absMs < hour) value = `${Math.round(absMs / minute)}m`;
  else if (absMs < day) value = `${Math.round(absMs / hour)}h`;
  else value = `${Math.round(absMs / day)}d`;
  return deltaMs >= 0 ? `in ${value}` : `${value} ago`;
}

export function formatWaitResult(result: {
  status: string;
  reason?: string;
  current_owner?: string;
  reserved_for?: string;
  turn_id?: number;
  lease_expires_at?: string;
  claim_expires_at?: string;
  handoff?: Handoff | null;
  from_agent_id?: string | null;
  hint?: string;
}): string {
  switch (result.status) {
    case "not_yet": {
      if (result.current_owner) {
        const deadline = result.lease_expires_at
          ? ` (lease expires ${formatRelativeTime(result.lease_expires_at)})`
          : "";
        return `Not your turn — ${result.current_owner} holds turn ${result.turn_id ?? "?"}${deadline}.`;
      }
      if (result.reserved_for) {
        const deadline = result.claim_expires_at
          ? ` (claim expires ${formatRelativeTime(result.claim_expires_at)})`
          : "";
        return `Not your turn — turn ${result.turn_id ?? "?"} is reserved for ${result.reserved_for}${deadline}.`;
      }
      if (result.reason === "auto_claim_disabled") {
        return result.hint ?? "Parked — idle room left unclaimed.";
      }
      return "Not your turn yet.";
    }
    case "closed":
      return "The room is closed.";
    case "takeover_available":
      return `Takeover available: ${result.reason ?? "unknown"}.`;
    case "your_turn": {
      if (result.reason === "already_owner") {
        return "Already holding the stick.";
      }
      const header =
        result.from_agent_id != null
          ? `Your turn (turn ${result.turn_id ?? "?"}, ${result.reason ?? "claim"} from ${result.from_agent_id}).`
          : `Your turn (turn ${result.turn_id ?? "?"}, ${result.reason ?? "claim"}).`;
      const handoffBlock = result.handoff ? formatHandoff(result.handoff) : "";
      return handoffBlock ? `${header}\n\n${handoffBlock}` : header;
    }
    default:
      return result.status;
  }
}

export function formatHandoff(handoff: Handoff): string {
  const sections: string[] = [];

  if (handoff.status?.trim()) {
    sections.push(`Status:\n${indent(handoff.status.trim())}`);
  }

  if (handoff.next_action?.trim()) {
    sections.push(`Next action:\n${indent(handoff.next_action.trim())}`);
  }

  if (handoff.artifacts && handoff.artifacts.length > 0) {
    const lines = handoff.artifacts.map((artifact) => {
      const range = artifact.lines
        ? `:${artifact.lines[0]}-${artifact.lines[1]}`
        : "";
      const note = artifact.note ? ` — ${artifact.note}` : "";
      return `- ${artifact.path}${range} (${artifact.role})${note}`;
    });
    sections.push(`Artifacts:\n${lines.join("\n")}`);
  }

  if (handoff.open_questions && handoff.open_questions.length > 0) {
    const lines = handoff.open_questions.map((q) => `- ${q}`);
    sections.push(`Open questions:\n${lines.join("\n")}`);
  }

  if (handoff.do_not && handoff.do_not.length > 0) {
    const lines = handoff.do_not.map((q) => `- ${q}`);
    sections.push(`Do not:\n${lines.join("\n")}`);
  }

  return sections.join("\n\n");
}

export function indent(text: string, prefix = "  "): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `${prefix}${line}` : line))
    .join("\n");
}

export function printHelp(): void {
  process.stdout.write(`Usage: tt <command> [options]

Commands:
  tt whoami [--explain]
  tt list [path]
  tt join [path] [--force-new]
  tt leave [path]
  tt kick <agent_id> [path] [--reason TEXT] [--force]
  tt wait [path] [--timeout 110s] [--park] [--events --after N]
  tt try [path] [--park] [--events --after N]
  tt state [path]
  tt events [path] [--after N] [--limit N] [--wait|--follow] [--event TYPE[,TYPE]] [--target self|any|agent]
  tt msg send <recipient|room> <body...> [--interrupt] [--stdin] [--path DIR]
  tt msg recv [--wait|--follow] [--from agent] [--after N] [--target self|any|agent] [--path DIR]
  tt instructions show [path] [--harness claude|codex|antigravity|gemini|grok|opencode|all] [--scope effective|bundled|user|project]
  tt instructions edit [path] [--user|--project]
  tt instructions reset [path] (--user|--project)
  tt release [path] (--status TEXT --next-action TEXT | --stdin)
  tt pass [path] (--status TEXT --next-action TEXT | --stdin)
  tt assign <target|next> [path] (--status TEXT --next-action TEXT | --stdin)
  tt take [path] [--reason TEXT] [--operator-requested]
  tt takeover [path] [--reason TEXT] [--operator-requested]
  tt notes add <body> [--turn N] [--path DIR] [--stdin]
  tt notes list [--all] [--after NOTE_ID] [--limit N] [--path DIR]
  tt install <harness...> | --all [--print] [--copy] [--link]
  tt uninstall <harness...|agents> | --all | --shared [--print]
  tt self-update [--print] [--manager npm|pnpm|yarn|bun]

Harnesses: ${SUPPORTED_HARNESSES.join(", ")}

Common options:
  [path]     Defaults to the current working directory when omitted
  --agent ID   Override the default human identity
  --json       Force JSON output (also default when invoked from a harness)
  --text       Force human-readable text even when invoked from a harness
  --help, -h   Show help without running the command or changing room state
`);
}

export function printCommandHelp(command: {
  name: string;
  aliases?: string[];
  usage: string;
  description: string;
}): void {
  const aliases =
    command.aliases && command.aliases.length > 0
      ? `\nAliases: ${command.aliases.join(", ")}`
      : "";
  process.stdout.write(`Usage: ${command.usage}

${command.description}${aliases}

Common options:
  [path]     Defaults to the current working directory when omitted
  --agent ID   Override the default human identity
  --json       Force JSON output (also default when invoked from a harness)
  --text       Force human-readable text even when invoked from a harness
  --help, -h   Show help without running the command or changing room state
`);
}
