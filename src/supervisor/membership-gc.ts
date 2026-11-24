import { createHash } from "node:crypto";
import type { SqliteDatabase } from "../sqlite.js";
import type { GenerationRow } from "./state.js";

export const MEMBERSHIP_RECOVERY_MS = 2 * 60_000;

type Departure = "left" | "kicked" | "lost" | "room_removed";
export type WorkerGcReason = Exclude<Departure, "lost"> | "recovery_expired";

export interface WorkerGcTarget {
  worker_id: string;
  generation: number;
  pid: number;
  process_started_at: string;
  room_id: string;
  agent_id: string;
  reason: WorkerGcReason;
}

export const membershipGcSchema = `
  CREATE TABLE managed_room_memberships (
    host_id TEXT NOT NULL,
    address TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    session_id TEXT NOT NULL,
    pid INTEGER NOT NULL,
    process_started_at TEXT NOT NULL,
    room_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    departure TEXT,
    departed_at TEXT,
    PRIMARY KEY (host_id, address, token_hash, room_id, agent_id)
  );
  CREATE INDEX managed_room_memberships_member ON managed_room_memberships (room_id, agent_id);
  CREATE TABLE managed_room_guards (
    host_id TEXT NOT NULL,
    address TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    room_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    lease_id TEXT NOT NULL,
    pid INTEGER NOT NULL,
    process_started_at TEXT NOT NULL,
    PRIMARY KEY (host_id, pid, process_started_at)
  );
`;

export function deliveryTokenHash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** The room keeps enrollment evidence after its endpoint and member rows disappear. */
export function recordManagedMembership(db: SqliteDatabase, input: {
  host_id: string; address: string; secret: string | null; harness_session_id: string; room_id: string; agent_id: string;
}): void {
  if (!input.secret) return;
  db.prepare(`INSERT INTO managed_room_memberships
      (host_id, address, token_hash, session_id, pid, process_started_at, room_id, agent_id)
    SELECT ?, ?, ?, m.harness_session_id, m.harness_pid, trim(m.harness_process_started_at), m.room_id, m.agent_id
    FROM room_members m WHERE m.room_id = ? AND m.agent_id = ? AND m.harness_session_id = ?
      AND m.harness_host_id = ? AND m.harness_pid > 1 AND trim(m.harness_process_started_at) != ''
    ON CONFLICT DO UPDATE SET departure = NULL, departed_at = NULL
      WHERE managed_room_memberships.departure = 'lost'
        AND managed_room_memberships.session_id = excluded.session_id
        AND managed_room_memberships.pid = excluded.pid
        AND managed_room_memberships.process_started_at = excluded.process_started_at`)
    .run(input.host_id, input.address, deliveryTokenHash(input.secret), input.room_id, input.agent_id,
      input.harness_session_id, input.host_id);
}

export function recordManagedDeparture(db: SqliteDatabase, roomId: string, agentId: string | null,
  departure: Departure, at: string): void {
  db.prepare(`UPDATE managed_room_memberships SET departure = ?, departed_at = ?
    WHERE room_id = ? AND (? IS NULL OR agent_id = ?) AND (departure IS NULL OR departure = 'lost')`)
    .run(departure, at, roomId, agentId, agentId);
}

export function findWorkerGcTarget(db: SqliteDatabase, hostId: string, socket: string, generation: GenerationRow,
  now: Date): WorkerGcTarget | null {
  const { worker_id, pid, process_started_at, session_id, delivery_token_hash, ended_at } = generation;
  if (ended_at || !pid || !process_started_at || !session_id || !delivery_token_hash) return null;
  const address = `${socket}#${worker_id}@${generation.generation}`;
  const session = `harness:${session_id}`;
  const row = db.prepare<unknown[], { room_id: string; agent_id: string; departure: Departure; departed_at: string }>(`
    SELECT room_id, agent_id, departure, departed_at FROM managed_room_memberships
    WHERE host_id = ? AND address = ? AND token_hash = ? AND session_id = ? AND pid = ? AND process_started_at = ?
      AND departure IS NOT NULL
    ORDER BY departed_at DESC, departure = 'lost' DESC LIMIT 1`).get(hostId, address, delivery_token_hash, session, pid,
      process_started_at.trim());
  if (!row || (row.departure === "lost" && Date.parse(row.departed_at) + MEMBERSHIP_RECOVERY_MS > now.getTime())) return null;
  // A different session keeps the host alive. The worker can also move between
  // rooms, but a legacy CLI rejoining the exact membership it was kicked from
  // cannot undo the recorded departure before the next daemon tick.
  if (db.prepare(`SELECT 1 FROM room_members m
    WHERE m.harness_host_id = ? AND m.harness_pid = ? AND trim(m.harness_process_started_at) = ?
      AND (m.harness_session_id IS NOT ? OR m.room_id != ? OR m.agent_id != ? OR ? NOT IN ('left', 'kicked')) LIMIT 1`)
    .get(hostId, pid, process_started_at.trim(), session, row.room_id, row.agent_id, row.departure)) return null;
  return { worker_id, generation: generation.generation, pid, process_started_at, room_id: row.room_id, agent_id: row.agent_id,
    reason: row.departure === "lost" ? "recovery_expired" : row.departure };
}

export function hasSharedGeneration(generations: GenerationRow[], target: GenerationRow): boolean {
  return generations.some(other => (other.worker_id !== target.worker_id || other.generation !== target.generation) &&
    ((target.pid !== null && other.pid === target.pid) ||
     (target.pgid !== null && other.pgid === target.pgid)));
}

export interface ManagedGuard {
  pid: number;
  process_started_at: string;
  room_id: string;
  agent_id: string;
}

export function recordManagedGuard(db: SqliteDatabase, input: ManagedGuard & {
  host_id: string; address: string; secret: string; lease_id: string;
}): void {
  db.prepare(`INSERT OR IGNORE INTO managed_room_guards
    (host_id, address, token_hash, room_id, agent_id, lease_id, pid, process_started_at)
    SELECT m.host_id, m.address, m.token_hash, m.room_id, m.agent_id, r.lease_id, ?, ?
    FROM managed_room_memberships m JOIN path_rooms r ON r.room_id = m.room_id
    WHERE m.host_id = ? AND m.address = ? AND m.token_hash = ? AND m.room_id = ? AND m.agent_id = ?
      AND m.departure IS NULL AND r.owner = m.agent_id AND r.lease_id = ?`)
    .run(input.pid, input.process_started_at, input.host_id, input.address, deliveryTokenHash(input.secret),
      input.room_id, input.agent_id, input.lease_id);
}

export function listReleasedManagedGuards(db: SqliteDatabase, hostId: string, socket: string): ManagedGuard[] {
  return db.prepare<[string, string, string], ManagedGuard>(`SELECT g.pid, g.process_started_at, g.room_id, g.agent_id
    FROM managed_room_guards g LEFT JOIN path_rooms r ON r.room_id = g.room_id
    WHERE g.host_id = ? AND substr(g.address, 1, length(?) + 1) = ? || '#'
      AND (r.lease_id IS NOT g.lease_id OR r.owner IS NOT g.agent_id)`)
    .all(hostId, socket, socket);
}
