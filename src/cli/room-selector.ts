import fs from "node:fs";
import path from "node:path";
import { ROOM_DECLARATION_FILE, readDeclaration, resolveContextPath } from "../path-resolution.js";
import type { PathRoom } from "../types.js";
import { getStringOption, type ParsedCommand } from "./parser.js";
import type { Runtime } from "./runtime.js";

export class RoomSelectorError extends Error {
  constructor(readonly reason: "not_found" | "ambiguous", message: string) {
    super(message);
    this.name = "RoomSelectorError";
  }
}

// `--in` wins over TT_ROOM; both name a room explicitly, bypassing path
// resolution. A launcher pins agents with TT_ROOM=<room_id>. (`--room` is
// already the msg flag for addressing the whole room.)
export function roomSelectorFrom(parsed: ParsedCommand, env: NodeJS.ProcessEnv = process.env): string | null {
  const selector = getStringOption(parsed, "in") ?? env.TT_ROOM;
  return selector?.trim() ? selector.trim() : null;
}

/** The declared `name` when the room's directory declares one, else its basename. */
export function roomShortName(room: Pick<PathRoom, "canonical_path">): string {
  const file = path.join(room.canonical_path, ROOM_DECLARATION_FILE);
  // Undeclared, or a keyed path that exists only in a linked worktree.
  const name = fs.existsSync(file) ? readDeclaration(file).name : null;
  return name ?? (path.basename(room.canonical_path) || room.canonical_path);
}

// Accepts a room id, an absolute room path, `root` (the repository room for
// contextPath), a short name (`api`, `#api`), or a path suffix (`web/api`).
// Exactly one open room must match; never creates.
export function resolveRoomSelector(rooms: readonly PathRoom[], selector: string, contextPath: string = process.cwd()): PathRoom {
  const open = rooms.filter((room) => room.state !== "closed");
  const wanted = selector.replace(/^#/, "");
  if (wanted === "root") {
    const anchor = resolveContextPath(contextPath).workspace_root;
    const root = open.find((room) => room.canonical_path === anchor);
    if (root) return root;
    throw new RoomSelectorError("not_found", `No open room at the repository root ${anchor}. Run \`tt join ${anchor}\` first.`);
  }
  const byId = open.filter((room) => room.room_id === wanted);
  if (byId.length === 1) return byId[0];
  const byPath = path.isAbsolute(wanted)
    ? open.filter((room) => room.canonical_path === path.resolve(wanted))
    : open.filter((room) => roomShortName(room) === wanted ||
        room.canonical_path.endsWith(`${path.sep}${wanted.split("/").join(path.sep)}`));
  if (byPath.length === 1) return byPath[0];
  if (byPath.length === 0) {
    throw new RoomSelectorError("not_found", `No open room matches ${selector}. Run \`tt room list\` to see rooms.`);
  }
  throw new RoomSelectorError("ambiguous", `${selector} matches several rooms: ${byPath.map((room) =>
    `${room.canonical_path} (${room.room_id})`).join(", ")}. Use a longer path or the room id.`);
}

/** The explicitly selected room, or null when the command should resolve its path.
 * An absolute path to a directory that itself declares a room selects that
 * room, even inside a linked worktree, whose room is keyed by the main
 * checkout's path. Rooms are deleted once empty, so a launcher pins agents by
 * that path (`tt room ensure` returns it as `pin`); with `reopen`, the next
 * join brings the room back. Ids and short names never reopen, and read-only
 * commands never create a room. */
export function selectedRoom(runtime: Runtime, parsed: ParsedCommand, env: NodeJS.ProcessEnv = process.env,
  options: { reopen?: boolean } = {}): PathRoom | null {
  const selector = roomSelectorFrom(parsed, env);
  if (!selector) return null;
  const rooms = runtime.commands.listRooms({}).rooms;
  try {
    return resolveRoomSelector(rooms, selector, getStringOption(parsed, "path") ?? process.cwd());
  } catch (error) {
    if (!(error instanceof RoomSelectorError) || error.reason !== "not_found") throw error;
    const declared = path.isAbsolute(selector) ? declaredRoomAt(selector) : null;
    if (!declared) throw error;
    const open = rooms.find((room) => room.state !== "closed" && room.canonical_path === declared.room_path);
    if (open) return open;
    if (!options.reopen) {
      throw new RoomSelectorError("not_found", `${error.message} ${selector} declares a room that is empty; \`tt join\` reopens it.`);
    }
    return runtime.commands.openRoom({ context_path: declared.directory });
  }
}

// When this absolute path is a directory whose own .talking-stick/room.toml
// declares a room: that directory and the path the room is keyed by.
export function declaredRoomAt(selector: string): { directory: string; room_path: string } | null {
  const wanted = path.resolve(selector);
  if (!fs.statSync(wanted, { throwIfNoEntry: false })?.isDirectory()) return null;
  const resolved = resolveContextPath(wanted);
  const declaration = resolved.declaration;
  if (!declaration || declaration.directory !== resolved.canonical_context_path) return null;
  return { directory: declaration.directory, room_path: resolved.room_path };
}
