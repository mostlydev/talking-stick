import path from "node:path";
import { exportRoomLogbook, readRoomLogbookExport, renderRoomLogbook, type RoomHandoffDeclarationChange } from "../room-handoff.js";
import { sanitizeChatText } from "./chat-format.js";
import { readAllStdin } from "./handoff.js";
import { deriveCliIdentity } from "./identity.js";
import { printResult } from "./output.js";
import { getStringOption, hasOption, type ParsedCommand } from "./parser.js";
import { briefTarget } from "./room-admin.js";
import type { Runtime } from "./runtime.js";

export const ROOM_HANDOFF_USAGE = [
  "tt handoff [--in ROOM]",
  "tt handoff add --stdin [--in ROOM] [--snapshot ID]",
  "tt handoff show [ROOM] [--in ROOM] [--snapshot ID]",
  "tt handoff export <new-directory> | import <directory> [--in ROOM]"
].join("\n");

function declarationNotice(declaration?: RoomHandoffDeclarationChange): string {
  if (!declaration) return "";
  const verb = declaration.change === "created" ? "Created" : "Enabled handoffs in";
  return `\n${verb} ${sanitizeChatText(declaration.file)} with id ${declaration.id}. Keep the declaration with the project so moves can inherit the logbook.`;
}

export async function handleRoomHandoffCommand(runtime: Runtime, parsed: ParsedCommand): Promise<void> {
  const [action, argument, ...extra] = parsed.positionals;
  const snapshotId = getStringOption(parsed, "snapshot");
  if (extra.length || (hasOption(parsed, "snapshot") && !snapshotId)) throw new Error(ROOM_HANDOFF_USAGE);
  const room = briefTarget(runtime, parsed, action === "show" ? argument : undefined);
  if (!action) {
    const snapshot = runtime.commands.startRoomHandoff(deriveCliIdentity(parsed), room.room_id);
    printResult(parsed, snapshot, () => `Room handoff ${snapshot.snapshot_id} requested ${snapshot.requested.length} stories. See tt handoff show.${declarationNotice(snapshot.declaration)}`);
    return;
  }
  if (action === "add" && !argument && hasOption(parsed, "stdin")) {
    const story = runtime.commands.addRoomHandoffStory(deriveCliIdentity(parsed), room.room_id, await readAllStdin(), snapshotId);
    printResult(parsed, { saved: true, author: story.agent_id, date: story.created_at }, () => "Saved your room handoff story.");
    return;
  }
  if (action === "import" && argument) {
    const imported = runtime.commands.importRoomHandoff(deriveCliIdentity(parsed), room.room_id, readRoomLogbookExport(path.resolve(argument)));
    printResult(parsed, imported, () => `Imported ${imported.stories.length} stories. See tt handoff show.${declarationNotice(imported.declaration)}`);
    return;
  }
  if (action !== "show" && !(action === "export" && argument)) {
    throw new Error(ROOM_HANDOFF_USAGE);
  }
  const snapshot = runtime.commands.showRoomHandoff(room.room_id, snapshotId);
  if (!snapshot) {
    printResult(parsed, { room_id: room.room_id, handoff: null }, () => "No room handoff.");
    return;
  }
  if (action === "show") {
    printResult(parsed, { room_id: room.room_id, handoff: snapshot }, () => sanitizeChatText([
      renderRoomLogbook(snapshot),
      ...snapshot.stories.map(story => `## ${story.agent_id}\n\n${story.body}`)
    ].join("\n")));
    return;
  }
  const contextFile = exportRoomLogbook(path.resolve(argument!), snapshot);
  printResult(parsed, { snapshot_id: snapshot.snapshot_id, context_file: contextFile }, () => contextFile);
}
