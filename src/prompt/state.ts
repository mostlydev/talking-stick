// What a shell prompt shows about the current folder's room. Everything here
// is read-only and spawns nothing: no join, no git subprocess, no service, no
// writes, so it can run on every prompt. Keep its imports small; they are the
// whole cost of `rooms prompt`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDataDir } from "../config.js";
import { humanAttentionWhere } from "../human-attention.js";
import { sanitizeIdentityComponent } from "../identity-name.js";
import {
  ROOM_DECLARATION_FILE,
  readDeclaration,
  resolveContextPath,
  resolveGitRootsFromFilesystem,
  roomCandidatePaths
} from "../path-resolution.js";
import { openSqlite, type SqliteDatabase } from "../sqlite.js";

export interface PromptState {
  room_id: string;
  /** The declared name, else the room folder's basename. */
  room: string;
  room_path: string;
  /** Joined agents whose process is not known to be gone; chat consoles excluded. */
  members: number;
  names: string[];
  /** The stick holder's name while its lease is live. */
  holder: string | null;
  blockers: number;
  /** Messages addressed to this human that no console of theirs has read. */
  unread: number;
}

export interface PromptStateOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  /** Same-host process check; injectable for tests. */
  processAlive?: (pid: number) => boolean;
}

interface RoomRow { room_id: string; canonical_path: string; owner: string | null; lease_expires_at: string | null; state: string }
interface MemberRow {
  agent_id: string; display_name: string | null; session_kind: string; status: string;
  host_id: string | null; pid: number | null; harness_host_id: string | null; harness_pid: number | null;
}

/** The room for `cwd` (or TT_ROOM), or null when there is none or anything fails. */
export function readPromptState(options: PromptStateOptions = {}): PromptState | null {
  const env = options.env ?? process.env;
  const file = path.join(resolveDataDir({ env }), "rooms.sqlite");
  if (!fs.existsSync(file)) return null;
  let db: SqliteDatabase | null = null;
  try {
    db = openSqlite(file, { readonly: true, timeout: 25 });
    const room = findRoom(db, options.cwd ?? process.cwd(), env.TT_ROOM?.trim() || null);
    if (!room) return null;
    return describeRoom(db, room, {
      human: humanId(env),
      now: options.now ?? new Date(),
      processAlive: options.processAlive ?? processAlive
    });
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* read-only; nothing to lose */ }
  }
}

function findRoom(db: SqliteDatabase, cwd: string, pin: string | null): RoomRow | null {
  const select = "SELECT room_id, canonical_path, owner, lease_expires_at, state FROM path_rooms";
  if (pin) {
    // A pin names a room by id or by absolute path, as launchers set it.
    const pinned = db.prepare(`${select} WHERE room_id = ? OR canonical_path = ?`).get(pin, pin) as RoomRow | undefined;
    if (pinned && pinned.state !== "closed") return pinned;
  }
  const resolved = resolveContextPath(cwd, { gitRoots: resolveGitRootsFromFilesystem });
  const byPath = db.prepare(`${select} WHERE canonical_path = ?`);
  // Most specific first, the same order the service uses.
  for (const candidate of roomCandidatePaths(resolved)) {
    const row = byPath.get(candidate) as RoomRow | undefined;
    if (row) return row.state === "closed" ? null : row;
  }
  return null;
}

function describeRoom(db: SqliteDatabase, room: RoomRow,
  context: { human: string; now: Date; processAlive: (pid: number) => boolean }): PromptState {
  const members = (db.prepare(`SELECT agent_id, display_name, session_kind, status, host_id, pid, harness_host_id, harness_pid
    FROM room_members WHERE room_id = ? ORDER BY ordinal`).all(room.room_id) as MemberRow[])
    .filter((member) => member.session_kind !== "human_chat" && member.status === "active" &&
      !processGone(member, context.processAlive));
  const nameOf = (agentId: string) => {
    const member = members.find((candidate) => candidate.agent_id === agentId);
    return member?.display_name?.trim() || agentId.split(":")[0];
  };
  const leaseLive = room.owner !== null &&
    (room.lease_expires_at === null || Date.parse(room.lease_expires_at) > context.now.getTime());
  return {
    room_id: room.room_id,
    room: roomName(room.canonical_path),
    room_path: room.canonical_path,
    members: members.length,
    names: members.map((member) => nameOf(member.agent_id)),
    holder: leaseLive && room.owner ? nameOf(room.owner) : null,
    blockers: countOrZero(() => (db.prepare("SELECT COUNT(*) AS n FROM room_blockers WHERE room_id = ? AND closed_at IS NULL")
      .get(room.room_id) as { n: number }).n),
    unread: countOrZero(() => {
      const cleared = (db.prepare("SELECT cleared_through_event_seq AS seq FROM human_chat_cursors WHERE room_id = ? AND human_id = ?")
        .get(room.room_id, context.human) as { seq: number } | undefined)?.seq ?? 0;
      const { where, values } = humanAttentionWhere(room.room_id, context.human, cleared);
      return (db.prepare(`SELECT COUNT(*) AS n FROM room_events e WHERE ${where}`).get(...values) as { n: number }).n;
    })
  };
}

// An older database without a table counts as nothing, never as an error.
function countOrZero(count: () => number): number {
  try { return count(); } catch { return 0; }
}

function roomName(roomPath: string): string {
  const file = path.join(roomPath, ROOM_DECLARATION_FILE);
  const declared = fs.existsSync(file) ? readDeclaration(file).name : null;
  return declared ?? (path.basename(roomPath) || roomPath);
}

function humanId(env: NodeJS.ProcessEnv): string {
  let username: string;
  try { username = os.userInfo().username; } catch { username = env.USER ?? env.LOGNAME ?? "user"; }
  return `human:${sanitizeIdentityComponent(username)}`;
}

// Only a same-host pid can be checked without a subprocess; anything else is
// kept, as the chat footer keeps a member whose process it cannot read.
function processGone(member: MemberRow, alive: (pid: number) => boolean): boolean {
  const pid = member.harness_pid ?? member.pid;
  const host = member.harness_pid ? (member.harness_host_id ?? member.host_id) : member.host_id;
  if (!pid || !host || !sameHost(host)) return false;
  return !alive(pid);
}

function sameHost(host: string): boolean {
  const local = os.hostname();
  return host === local || host === local.replace(/\.local$/, "");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
