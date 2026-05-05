import { SUPPORTED_HARNESSES } from "../install.js";
import type { Handoff } from "../index.js";
import { isKnownHarnessCliEnv } from "./identity.js";
import { hasOption, type ParsedCommand } from "./parser.js";

export function printResult(
  parsed: ParsedCommand,
  result: unknown,
  renderText: () => string
): void {
  if (shouldUseJson(parsed)) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
  tt wait [path] [--timeout 30s]
  tt try [path]
  tt state [path]
  tt events [path] [--after N] [--limit N] [--wait|--follow] [--event TYPE[,TYPE]] [--target self|any|agent]
  tt msg send <recipient|room> <body...> [--interrupt] [--stdin] [--path DIR]
  tt msg recv [--wait|--follow] [--from agent] [--after N] [--target self|any|agent] [--path DIR]
  tt release [path] (--status TEXT --next-action TEXT | --stdin)
  tt pass [path] (--status TEXT --next-action TEXT | --stdin)
  tt assign <target|next> [path] (--status TEXT --next-action TEXT | --stdin)
  tt take [path] [--reason TEXT] [--operator-requested]
  tt takeover [path] [--reason TEXT] [--operator-requested]
  tt notes add <body> [--turn N] [--path DIR] [--stdin]
  tt notes list [--all] [--after NOTE_ID] [--limit N] [--path DIR]
  tt install <harness...> | --all [--print] [--copy] [--link]
  tt uninstall <harness...> | --all [--print]
  tt self-update [--print] [--manager npm|pnpm|yarn|bun]

Harnesses: ${SUPPORTED_HARNESSES.join(", ")}

Common options:
  --agent ID   Override the default human identity
  --json       Force JSON output (also default when invoked from a harness)
  --text       Force human-readable text even when invoked from a harness
`);
}
