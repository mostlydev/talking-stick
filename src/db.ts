import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import DatabaseConstructor from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { resolveDataDir } from "./config.js";

export type SqliteDatabase = BetterSqlite3.Database;

export interface OpenDatabaseOptions {
  dbPath?: string;
  dataDir?: string;
  filesystemTypeOptions?: FilesystemTypeOptions;
}

export type FilesystemExecFile = (
  file: string,
  args: readonly string[],
  options: {
    encoding: "utf8";
    stdio: ["ignore", "pipe", "ignore"];
  }
) => string;

export interface FilesystemTypeOptions {
  platform?: NodeJS.Platform;
  execFile?: FilesystemExecFile;
}

interface Migration {
  id: number;
  name: string;
  up: string;
}

const migrations: Migration[] = [
  {
    id: 1,
    name: "initial_schema",
    up: `
      CREATE TABLE path_rooms (
        room_id TEXT PRIMARY KEY,
        canonical_path TEXT NOT NULL,
        sequence_index INTEGER NOT NULL DEFAULT 0,
        owner TEXT,
        reserved_for TEXT,
        pending_handoff_event_seq INTEGER,
        turn_id INTEGER NOT NULL DEFAULT 0,
        lease_id TEXT,
        lease_expires_at TEXT,
        claim_expires_at TEXT,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (canonical_path)
      );

      CREATE INDEX path_rooms_canonical_path_idx
        ON path_rooms (canonical_path);

      CREATE TABLE room_members (
        room_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        joined_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        status TEXT NOT NULL,
        PRIMARY KEY (room_id, agent_id),
        FOREIGN KEY (room_id) REFERENCES path_rooms(room_id)
      );

      CREATE TABLE room_events (
        event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        room_id TEXT NOT NULL,
        turn_id INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        from_agent_id TEXT,
        to_agent_id TEXT,
        handoff_json TEXT,
        reason TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (room_id) REFERENCES path_rooms(room_id)
      );

      CREATE INDEX room_events_room_seq_idx
        ON room_events (room_id, event_seq);

      CREATE INDEX room_events_room_turn_idx
        ON room_events (room_id, turn_id);
    `
  },
  {
    id: 2,
    name: "room_member_process_metadata",
    up: `
      ALTER TABLE room_members ADD COLUMN host_id TEXT;
      ALTER TABLE room_members ADD COLUMN pid INTEGER;
      ALTER TABLE room_members ADD COLUMN process_started_at TEXT;
      ALTER TABLE room_members ADD COLUMN session_kind TEXT NOT NULL DEFAULT 'mcp_harness';
      ALTER TABLE room_members ADD COLUMN display_name TEXT;
    `
  },
  {
    id: 3,
    name: "non_owner_notes",
    up: `
      CREATE TABLE notes (
        note_id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        turn_id INTEGER,
        author_agent_id TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by_agent_id TEXT,
        FOREIGN KEY (room_id) REFERENCES path_rooms(room_id) ON DELETE CASCADE
      );

      CREATE INDEX notes_by_room_created
        ON notes (room_id, created_at, note_id);
    `
  },
  {
    id: 4,
    name: "room_member_wait_presence",
    up: `
      ALTER TABLE room_members ADD COLUMN last_wait_at TEXT;
    `
  },
  {
    id: 5,
    name: "room_events_payload_json",
    up: `
      ALTER TABLE room_events ADD COLUMN payload_json TEXT;
    `
  },
  {
    id: 6,
    name: "room_member_harness_instance_metadata",
    up: `
      ALTER TABLE room_members ADD COLUMN harness_name TEXT;
      ALTER TABLE room_members ADD COLUMN harness_session_id TEXT;
      ALTER TABLE room_members ADD COLUMN harness_host_id TEXT;
      ALTER TABLE room_members ADD COLUMN harness_pid INTEGER;
      ALTER TABLE room_members ADD COLUMN harness_process_started_at TEXT;
    `
  },
  {
    id: 7,
    name: "room_member_last_park_hint_event_seq",
    up: `
      ALTER TABLE room_members ADD COLUMN last_park_hint_event_seq INTEGER;
    `
  }
];

export function resolveDatabasePath(options: OpenDatabaseOptions = {}): string {
  if (options.dbPath) {
    return path.resolve(options.dbPath);
  }

  const dataDir = options.dataDir
    ? path.resolve(options.dataDir)
    : resolveDataDir();

  return path.join(dataDir, "rooms.sqlite");
}

export function openDatabase(options: OpenDatabaseOptions = {}): SqliteDatabase {
  const dbPath = resolveDatabasePath(options);
  assertLocalFilesystem(path.dirname(dbPath), options.filesystemTypeOptions);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new DatabaseConstructor(dbPath);
  applyPragmas(db);
  migrate(db);
  return db;
}

export function applyPragmas(db: SqliteDatabase): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
}

export function migrate(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db
      .prepare<[], { id: number }>("SELECT id FROM schema_migrations")
      .all()
      .map((row) => row.id)
  );

  for (const migration of migrations) {
    if (applied.has(migration.id)) {
      continue;
    }

    withImmediateTransaction(db, () => {
      db.exec(migration.up);
      db.prepare(
        "INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)"
      ).run(migration.id, migration.name, new Date().toISOString());
    });
  }
}

export function withImmediateTransaction<T>(
  db: SqliteDatabase,
  fn: () => T
): T {
  db.prepare("BEGIN IMMEDIATE").run();
  try {
    const result = fn();
    db.prepare("COMMIT").run();
    return result;
  } catch (error) {
    db.prepare("ROLLBACK").run();
    throw error;
  }
}

export function assertLocalFilesystem(
  targetPath: string,
  options: FilesystemTypeOptions = {}
): void {
  const filesystemType = detectFilesystemType(targetPath, options);
  if (!filesystemType) {
    return;
  }

  if (isRemoteFilesystemType(filesystemType)) {
    throw new Error(
      `Talking Stick requires a local filesystem for SQLite state. Detected ${filesystemType} at ${targetPath}. Set TALKING_STICK_DATA_DIR to a local path.`
    );
  }
}

export function detectFilesystemType(
  targetPath: string,
  options: FilesystemTypeOptions = {}
): string | null {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return null;
  }

  const existingPath = nearestExistingPath(targetPath);
  const execFile: FilesystemExecFile =
    options.execFile ??
    ((file, args, execOptions) =>
      execFileSync(file, args, execOptions) as string);

  try {
    const args =
      platform === "linux"
        ? ["-f", "-c", "%T", existingPath]
        : ["-f", "%T", existingPath];

    return execFile("stat", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    })
      .trim()
      .toLowerCase();
  } catch {
    return null;
  }
}

function nearestExistingPath(targetPath: string): string {
  let current = path.resolve(targetPath);

  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }

  return current;
}

function isRemoteFilesystemType(filesystemType: string): boolean {
  return /^(nfs|smbfs|cifs)/.test(filesystemType);
}
