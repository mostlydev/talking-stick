import { deriveCliIdentity } from "./identity.js";
import { readAllStdin } from "./handoff.js";
import {
  getStringOption,
  hasOption,
  parseOptionalInteger,
  type ParsedCommand
} from "./parser.js";
import {
  formatRelativeTime,
  printResult
} from "./output.js";
import { resolveSessionForNotes } from "./session.js";
import type { Runtime } from "./runtime.js";

export async function handleNotesCommand(
  runtime: Runtime,
  parsed: ParsedCommand
): Promise<void> {
  const [subcommand, ...rest] = parsed.positionals;
  if (!subcommand) {
    throw new Error(
      "Usage: tt notes <add|list> [...]. See `tt --help` for details."
    );
  }

  const subParsed: ParsedCommand = {
    name: `notes ${subcommand}`,
    positionals: rest,
    options: parsed.options
  };

  switch (subcommand) {
    case "add":
      await handleNotesAddCommand(runtime, subParsed);
      return;
    case "list":
      handleNotesListCommand(runtime, subParsed);
      return;
    default:
      throw new Error(`Unknown notes subcommand: ${subcommand}`);
  }
}

async function handleNotesAddCommand(
  runtime: Runtime,
  parsed: ParsedCommand
): Promise<void> {
  const identity = deriveCliIdentity(parsed);
  const session = resolveSessionForNotes(runtime, parsed, identity);

  const positionalBody = parsed.positionals.join(" ").trim();
  const body =
    positionalBody ||
    (hasOption(parsed, "stdin") ? (await readAllStdin()).trim() : "");
  if (!body) {
    throw new Error(
      "Note body is required (pass as a positional or use --stdin to read from stdin)."
    );
  }

  const turnId = parseOptionalInteger(parsed, "turn");

  const result = runtime.commands.addNote(identity, {
    room_id: session.room_id,
    body,
    turn_id: turnId
  });

  printResult(
    parsed,
    result,
    () =>
      `Added note ${shortNoteId(result.note_id)} (turn=${
        result.turn_id ?? "-"
      }).`
  );
}

function handleNotesListCommand(
  runtime: Runtime,
  parsed: ParsedCommand
): void {
  const identity = deriveCliIdentity(parsed);
  const session = resolveSessionForNotes(runtime, parsed, identity);
  const includeResolved = hasOption(parsed, "all");

  const result = runtime.commands.listNotes(identity, {
    room_id: session.room_id,
    include_resolved: includeResolved,
    include_all:
      includeResolved ||
      hasOption(parsed, "after") ||
      hasOption(parsed, "limit"),
    after_note_id: getStringOption(parsed, "after"),
    limit: parseOptionalInteger(parsed, "limit")
  });

  printResult(parsed, result, () => {
    if (result.notes.length === 0) {
      const hidden = result.hidden?.notes;
      if (hidden && hidden.older_count > 0) {
        return `No recent notes. ${hidden.older_count} older note${hidden.older_count === 1 ? "" : "s"} hidden; use --all.`;
      }
      return "No notes.";
    }

    const header = `${result.notes.length} note${result.notes.length === 1 ? "" : "s"} in this room:`;
    const lines = result.notes.map((note) => {
      const scope = note.turn_id !== null ? `turn ${note.turn_id}` : "room-scoped";
      const firstLine = note.body.split("\n")[0] ?? "";
      const preview =
        firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
      return `- ${shortNoteId(note.note_id)} ${note.author_agent_id} · ${formatRelativeTime(note.created_at)} · ${scope}\n  ${preview}`;
    });
    const hidden = result.hidden?.notes;
    const hiddenLine =
      hidden && hidden.older_count > 0
        ? `${hidden.older_count} older note${hidden.older_count === 1 ? "" : "s"} hidden; use --all.`
        : null;
    return [header, ...lines, ...(hiddenLine ? [hiddenLine] : [])].join("\n");
  });
}

function shortNoteId(noteId: string): string {
  return noteId.slice(0, 8);
}
