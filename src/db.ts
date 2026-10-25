import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { openSqlite, type SqliteDatabase } from "./sqlite.js";
import { resolveDataDir } from "./config.js";

export type { SqliteDatabase } from "./sqlite.js";

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
      ALTER TABLE room_members ADD COLUMN session_kind TEXT NOT NULL DEFAULT 'harness_cli';
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
  },
  {
    id: 8,
    name: "wait_intent_and_standby",
    up: `
      ALTER TABLE room_members ADD COLUMN wait_intent TEXT;
      ALTER TABLE room_members ADD COLUMN standby_transport TEXT;
      ALTER TABLE room_members ADD COLUMN standby_workspace_id TEXT;
      ALTER TABLE room_members ADD COLUMN standby_surface_id TEXT;
      ALTER TABLE room_members ADD COLUMN standby_generation INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE room_members ADD COLUMN standby_wake_pending INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE room_members ADD COLUMN standby_registered_at TEXT;
      ALTER TABLE room_members ADD COLUMN standby_last_error TEXT;
      ALTER TABLE room_members ADD COLUMN standby_delivered_at TEXT;
      UPDATE room_members
      SET wait_intent = 'active'
      WHERE last_wait_at IS NOT NULL;
    `
  },
  {
    id: 9,
    name: "foreground_wait_receivers",
    up: `
      ALTER TABLE room_members
        ADD COLUMN receiver_generation INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE room_receivers (
        room_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        receiver_id TEXT NOT NULL,
        harness_session_id TEXT,
        host_id TEXT NOT NULL,
        pid INTEGER NOT NULL,
        process_started_at TEXT NOT NULL,
        cursor_event_seq INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        registered_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        PRIMARY KEY (room_id, agent_id),
        UNIQUE (receiver_id),
        FOREIGN KEY (room_id, agent_id)
          REFERENCES room_members(room_id, agent_id) ON DELETE CASCADE
      );

      CREATE INDEX room_receivers_room_idx
        ON room_receivers (room_id, agent_id);
    `
  },
  {
    id: 10,
    name: "interrupt_wake_endpoints",
    up: `
      ALTER TABLE room_members ADD COLUMN wake_workspace_id TEXT;
      ALTER TABLE room_members ADD COLUMN wake_surface_id TEXT;
      ALTER TABLE room_members ADD COLUMN wake_endpoint_session_id TEXT;
      ALTER TABLE room_members ADD COLUMN wake_endpoint_recorded_at TEXT;
      ALTER TABLE room_members ADD COLUMN wake_interrupt_delivered_at TEXT;
    `
  },
  {
    id: 11,
    name: "interrupt_wake_endpoint_generation",
    up: `
      ALTER TABLE room_members
        ADD COLUMN wake_endpoint_generation INTEGER NOT NULL DEFAULT 0;
    `
  },
  {
    id: 12,
    name: "native_wake_endpoints",
    up: `
      CREATE TABLE member_wake_endpoints (
        room_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        transport TEXT NOT NULL,
        address TEXT NOT NULL,
        secret TEXT,
        harness_session_id TEXT NOT NULL,
        host_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        recorded_at TEXT NOT NULL,
        wake_pending INTEGER NOT NULL DEFAULT 0,
        wake_reason TEXT,
        wake_from_agent_id TEXT,
        awaiting_wait INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        last_status TEXT,
        last_error TEXT,
        PRIMARY KEY (room_id, agent_id, transport),
        FOREIGN KEY (room_id, agent_id)
          REFERENCES room_members(room_id, agent_id) ON DELETE CASCADE
      );
    `
  },
  {
    id: 13,
    name: "native_wake_batch_cursor",
    up: `
      ALTER TABLE member_wake_endpoints ADD COLUMN wake_event_seq INTEGER;
    `
  },
  {
    id: 14,
    name: "unified_wake_batches",
    up: `
      ALTER TABLE member_wake_endpoints ADD COLUMN batch_id TEXT;
      ALTER TABLE member_wake_endpoints ADD COLUMN dispatch_event_seq INTEGER;
      INSERT OR IGNORE INTO member_wake_endpoints
        (room_id, agent_id, transport, address, secret, harness_session_id, host_id, generation, recorded_at)
      SELECT room_id, agent_id, 'cmux',
        json_object('workspace_id', COALESCE(standby_workspace_id, wake_workspace_id),
                    'surface_id', COALESCE(standby_surface_id, wake_surface_id)), NULL,
        COALESCE(harness_session_id, 'member:' || agent_id),
        COALESCE(harness_host_id, host_id, ''), 1,
        COALESCE(standby_registered_at, wake_endpoint_recorded_at, joined_at)
      FROM room_members
      WHERE (standby_transport = 'cmux' AND standby_workspace_id IS NOT NULL AND standby_surface_id IS NOT NULL)
         OR (wake_workspace_id IS NOT NULL AND wake_surface_id IS NOT NULL AND wake_endpoint_session_id = harness_session_id);
    `
  },
  {
    id: 15,
    name: "forced_interrupt_deliveries",
    up: `
      CREATE TABLE interrupt_deliveries (
        room_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        event_seq INTEGER NOT NULL,
        harness_session_id TEXT NOT NULL,
        host_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        attempted_at TEXT,
        transport TEXT,
        error TEXT,
        PRIMARY KEY (room_id, agent_id, event_seq),
        FOREIGN KEY (room_id, agent_id) REFERENCES room_members(room_id, agent_id) ON DELETE CASCADE,
        FOREIGN KEY (event_seq) REFERENCES room_events(event_seq) ON DELETE CASCADE
      );
      CREATE INDEX interrupt_deliveries_pending ON interrupt_deliveries(status, room_id);
    `
  },
  {
    id: 16,
    name: "message_receipts",
    up: `
      CREATE TABLE message_receipts (
        room_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        event_seq INTEGER NOT NULL,
        delivered_at TEXT NOT NULL,
        PRIMARY KEY (room_id, agent_id, event_seq),
        FOREIGN KEY (room_id, agent_id) REFERENCES room_members(room_id, agent_id) ON DELETE CASCADE,
        FOREIGN KEY (event_seq) REFERENCES room_events(event_seq) ON DELETE CASCADE
      );
    `
  },
  {
    id: 17,
    name: "native_event_acceptance",
    up: `
      CREATE TABLE native_event_receipts (
        room_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        event_seq INTEGER NOT NULL,
        consumed_at TEXT,
        acknowledged_at TEXT,
        PRIMARY KEY (room_id, agent_id, event_seq),
        FOREIGN KEY (room_id, agent_id) REFERENCES room_members(room_id, agent_id) ON DELETE CASCADE,
        FOREIGN KEY (event_seq) REFERENCES room_events(event_seq) ON DELETE CASCADE
      );
      CREATE TABLE native_delivery_batches (
        token TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        harness_session_id TEXT NOT NULL,
        host_id TEXT NOT NULL,
        event_seqs_json TEXT NOT NULL,
        acknowledged_at TEXT,
        FOREIGN KEY (room_id, agent_id) REFERENCES room_members(room_id, agent_id) ON DELETE CASCADE
      );
    `
  },
  {
    id: 18,
    name: "native_batch_retry_age",
    up: `ALTER TABLE member_wake_endpoints ADD COLUMN batch_started_at TEXT;`
  },
  {
    id: 19,
    name: "hook_delivery_reservations",
    up: `
      ALTER TABLE native_delivery_batches ADD COLUMN source TEXT NOT NULL DEFAULT 'native';
      ALTER TABLE native_delivery_batches ADD COLUMN created_at TEXT;
      CREATE INDEX hook_delivery_pending ON native_delivery_batches(room_id, agent_id, source, created_at);
    `
  },
  {
    id: 20,
    name: "ended_harness_sessions",
    up: `CREATE TABLE ended_harness_sessions (
      harness_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      host_id TEXT NOT NULL,
      pid INTEGER NOT NULL,
      process_started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      PRIMARY KEY (harness_name, session_id, host_id, pid, process_started_at)
    );
    CREATE INDEX ended_harness_sessions_age ON ended_harness_sessions(ended_at);
    CREATE TABLE ended_room_members (
      room_id TEXT NOT NULL REFERENCES path_rooms(room_id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      harness_name TEXT NOT NULL, session_id TEXT NOT NULL, host_id TEXT NOT NULL,
      pid INTEGER NOT NULL, process_started_at TEXT NOT NULL,
      PRIMARY KEY (room_id, agent_id)
    );`
  },
  {
    id: 21,
    name: "room_roles",
    up: `CREATE TABLE room_roles (
      room_id TEXT NOT NULL REFERENCES path_rooms(room_id) ON DELETE CASCADE,
      subject TEXT NOT NULL,
      roles_json TEXT NOT NULL,
      set_by TEXT,
      set_at TEXT NOT NULL,
      PRIMARY KEY (room_id, subject)
    );
    ALTER TABLE path_rooms ADD COLUMN roles_version INTEGER NOT NULL DEFAULT 0;`
  },
  {
    id: 22,
    name: "codex_turn_activity",
    up: `CREATE TABLE codex_turn_activity (
      session_id TEXT NOT NULL, host_id TEXT NOT NULL, pid INTEGER NOT NULL,
      process_started_at TEXT NOT NULL, turn_id TEXT NOT NULL,
      active INTEGER NOT NULL, updated_at TEXT NOT NULL,
      last_hook_event_seq INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, host_id, pid, process_started_at)
    );`
  },
  {
    id: 23,
    name: "visitor_requests",
    up: `CREATE TABLE visitor_requests (
      request_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      requester_agent_id TEXT NOT NULL,
      request_key TEXT,
      payload_digest TEXT NOT NULL,
      event_seq INTEGER NOT NULL,
      recipients_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX visitor_requests_room ON visitor_requests (room_id);
    CREATE UNIQUE INDEX visitor_requests_key ON visitor_requests (requester_agent_id, request_key)
      WHERE request_key IS NOT NULL;
    CREATE TABLE visitor_replies (
      request_id TEXT NOT NULL,
      event_seq INTEGER NOT NULL,
      PRIMARY KEY (request_id, event_seq)
    );`
  },
  {
    id: 24,
    name: "wake_error_detail",
    up: `ALTER TABLE member_wake_endpoints ADD COLUMN last_error_detail TEXT;`
  },
  {
    id: 25,
    name: "human_message_acknowledgements",
    up: `CREATE TABLE human_message_acknowledgements (
      room_id TEXT NOT NULL REFERENCES path_rooms(room_id) ON DELETE CASCADE,
      human_id TEXT NOT NULL,
      event_seq INTEGER NOT NULL REFERENCES room_events(event_seq) ON DELETE CASCADE,
      acknowledged_at TEXT NOT NULL,
      PRIMARY KEY (room_id, human_id, event_seq)
    );
    CREATE TABLE human_attention_start (id INTEGER PRIMARY KEY CHECK (id = 1), event_seq INTEGER NOT NULL);
    INSERT INTO human_attention_start SELECT 1, COALESCE(MAX(event_seq), 0) FROM room_events;`
  },
  {
    id: 26,
    name: "human_chat_preferences",
    up: `CREATE TABLE human_chat_preferences (
      human_id TEXT PRIMARY KEY,
      theme TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`
  },
  {
    id: 27,
    name: "human_chat_clear_cursors",
    up: `CREATE TABLE human_chat_cursors (
      room_id TEXT NOT NULL REFERENCES path_rooms(room_id) ON DELETE CASCADE,
      human_id TEXT NOT NULL,
      cleared_through_event_seq INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (room_id, human_id)
    );`
  },
  {
    id: 28,
    name: "native_steering_result",
    up: `ALTER TABLE native_delivery_batches ADD COLUMN delivery_mode TEXT;
    ALTER TABLE native_delivery_batches ADD COLUMN target_turn_id TEXT;
    ALTER TABLE native_delivery_batches ADD COLUMN recovery_checked_at TEXT;
    ALTER TABLE interrupt_deliveries ADD COLUMN delivery_token TEXT;
    -- Older chats expire any unacknowledged batch when new work arrives,
    -- even a possibly accepted steer. Preserve that exact held reservation.
    -- Cursor resets clear wake metadata; acknowledgements consume receipts;
    -- session replacement changes generation. Those exits remain available.
    CREATE TRIGGER protect_native_steering_expiry
      BEFORE UPDATE OF awaiting_wait, batch_id ON member_wake_endpoints
      WHEN OLD.awaiting_wait = 1 AND NEW.awaiting_wait = 0
        AND OLD.batch_id IS NOT NULL AND NEW.batch_id IS NULL
        AND NEW.generation = OLD.generation
        AND NEW.wake_pending = OLD.wake_pending
        AND NEW.wake_event_seq IS OLD.wake_event_seq
        AND NEW.wake_reason IS OLD.wake_reason
        AND EXISTS (SELECT 1 FROM native_delivery_batches b, json_each(b.event_seqs_json) j
          JOIN native_event_receipts n ON n.room_id = b.room_id AND n.agent_id = b.agent_id AND n.event_seq = j.value
          WHERE b.token = OLD.batch_id AND b.delivery_mode IN ('steering', 'steered', 'uncertain', 'recovering', 'recovery_uncertain') AND n.consumed_at IS NULL)
      BEGIN SELECT RAISE(IGNORE); END;`
  },
  {
    id: 29,
    name: "member_gone_observations",
    up: `CREATE TABLE member_gone_observations (
      room_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      identity TEXT NOT NULL,
      first_gone_at TEXT NOT NULL,
      PRIMARY KEY (room_id, agent_id),
      FOREIGN KEY (room_id, agent_id)
        REFERENCES room_members(room_id, agent_id) ON DELETE CASCADE
    );`
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
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  try { fs.closeSync(fs.openSync(dbPath, "wx", 0o600)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (process.platform !== "win32") {
    for (const filename of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        if ((fs.statSync(filename).mode & 0o077) !== 0) {
          fs.chmodSync(filename, 0o600);
          process.stderr.write("Talking Stick restricted state file permissions to owner-only.\n");
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }

  const db = openSqlite(dbPath);
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
