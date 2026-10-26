import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { writeFileAtomic } from "../atomic-write.js";
import { openSqlite } from "../sqlite.js";

// The supervisor's own state lives outside the tt data directory, which
// workers must be able to write for their room calls. One resolver decides
// where it is; nothing creates a root while older state still waits to move.

/** Bytes a UNIX socket path may use, less its terminator: macOS allows 104, Linux 108. */
const SOCKET_PATH_MAX = process.platform === "darwin" ? 103 : 107;
const ROOT_FILE = "root.json";
const JOURNAL_FILE = "migration.json";
/** In the data directory: which root owns its supervisor, so another base never quietly starts a second. */
const OWNER_MARKER = "supervisor.root.json";

export interface SupervisorRoot {
  /** The protected directory holding all supervisor-owned state. */
  dir: string;
  /** A stable id for the data directory it serves. */
  id: string;
  /** That data directory, canonical. */
  dataDir: string;
}

interface RootRecord { version: 1; id: string; data_dir: string; created_at: string; migrated_from_legacy?: boolean }

export type SupervisorStateKind =
  /** The root is initialized for this data directory. */
  | "ready"
  /** No supervisor state anywhere yet. */
  | "none"
  /** State from before the move is still in the data directory. */
  | "legacy"
  /** A migration started and did not finish. */
  | "migrating";

export class SupervisorStateError extends Error {}

/** A path's canonical form, even if it doesn't exist yet: its nearest existing ancestor, resolved, plus the rest. */
export function canonicalPath(target: string): string {
  let existing = path.resolve(target);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(existing), ...rest.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) return path.join(existing, ...rest.reverse());
      rest.push(path.basename(existing));
      existing = parent;
    }
  }
}

/** Where supervisor roots live: an explicit absolute TT_SUPERVISOR_STATE_DIR, else the platform's user state directory. */
export function supervisorStateBase(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const explicit = env.TT_SUPERVISOR_STATE_DIR;
  if (explicit !== undefined) {
    if (!path.isAbsolute(explicit)) throw new SupervisorStateError("TT_SUPERVISOR_STATE_DIR must be an absolute directory.");
    return path.resolve(explicit);
  }
  const home = env.HOME && path.isAbsolute(env.HOME) ? env.HOME : os.homedir();
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "talking-stick", "supervisor");
  const xdg = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(home, ".local", "state");
  return path.join(xdg, "talking-stick", "supervisor");
}

export function supervisorRootFor(dataDir: string, env: NodeJS.ProcessEnv = process.env): SupervisorRoot {
  const canonical = canonicalPath(dataDir);
  const id = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const dir = path.join(canonicalPath(supervisorStateBase(env)), id);
  if (Buffer.byteLength(path.join(dir, "control.sock")) > SOCKET_PATH_MAX) {
    throw new SupervisorStateError(`The supervisor state path ${dir} is too long for its sockets. ` +
      "Set TT_SUPERVISOR_STATE_DIR to a shorter absolute directory.");
  }
  return { dir, id, dataDir: canonical };
}

/** Everything the older layout kept in the data directory. */
export function legacyPaths(dataDir: string) {
  return {
    database: path.join(dataDir, "supervisor.sqlite"),
    dir: path.join(dataDir, "supervisor"),
    lock: path.join(dataDir, "supervisor", "owner.lock"),
    marker: path.join(dataDir, OWNER_MARKER)
  };
}

function hasLegacyState(dataDir: string): boolean {
  const legacy = legacyPaths(dataDir);
  return fs.existsSync(legacy.database) || fs.existsSync(path.join(legacy.dir, "workers")) ||
    fs.existsSync(path.join(legacy.dir, "logs"));
}

function readRootRecord(root: SupervisorRoot): RootRecord | null {
  const file = path.join(root.dir, ROOT_FILE);
  if (!fs.existsSync(file)) return null;
  let record: RootRecord;
  try { record = JSON.parse(fs.readFileSync(file, "utf8")) as RootRecord; }
  catch { throw new SupervisorStateError(`${file} is unreadable; nothing will guess what it held.`); }
  // An id collision or a copied root must never serve another data directory.
  if (record.version !== 1 || record.id !== root.id || record.data_dir !== root.dataDir) {
    throw new SupervisorStateError(`${file} belongs to ${record.data_dir ?? "another directory"}, not ${root.dataDir}.`);
  }
  return record;
}

/** Entries a root may hold before it is initialized: only an owner lock. */
function unrecordedEntries(root: SupervisorRoot): string[] {
  if (!fs.existsSync(root.dir)) return [];
  return fs.readdirSync(root.dir).filter((entry) => entry !== "owner.lock");
}

interface Journal { version: 1; id: string; from: string; retired: string; committed: boolean; started_at: string }

/** A journal is trusted only if it names this root, this data directory and a retirement path inside it. */
function readJournal(root: SupervisorRoot): Journal | null {
  const file = path.join(root.dir, JOURNAL_FILE);
  if (!fs.existsSync(file)) return null;
  let journal: Journal;
  try { journal = JSON.parse(fs.readFileSync(file, "utf8")) as Journal; }
  catch { throw new SupervisorStateError(`${file} is unreadable; the migration it recorded can't be trusted.`); }
  const retiredOk = typeof journal.retired === "string" && path.dirname(journal.retired) === root.dataDir &&
    /^supervisor-legacy-[0-9TZ-]+$/.test(path.basename(journal.retired));
  if (journal.version !== 1 || journal.id !== root.id || journal.from !== root.dataDir || !retiredOk ||
      typeof journal.committed !== "boolean") {
    throw new SupervisorStateError(`${file} doesn't describe a migration of ${root.dataDir} into ${root.dir}.`);
  }
  // A committed journal must agree with the root it committed.
  const record = readRootRecord(root);
  if (journal.committed && !record?.migrated_from_legacy) {
    throw new SupervisorStateError(`${file} says the migration committed, but ${root.dir} has no matching root.json.`);
  }
  if (!journal.committed && record) {
    throw new SupervisorStateError(`${file} says the migration didn't commit, but ${root.dir} already has root.json.`);
  }
  return journal;
}

/**
 * The data directory names the root that owns its supervisor. It is
 * provenance against a changed base or HOME, not a security boundary: the
 * data directory is worker-writable, and the root's own root.json decides.
 */
function checkOwnerMarker(root: SupervisorRoot): void {
  const file = legacyPaths(root.dataDir).marker;
  if (!fs.existsSync(file)) return;
  let marker: { root?: string; id?: string };
  try { marker = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new SupervisorStateError(`${file} is unreadable; nothing will guess which supervisor owns ${root.dataDir}.`); }
  if (marker.root !== root.dir || marker.id !== root.id) {
    throw new SupervisorStateError(`The supervisor for ${root.dataDir} lives in ${marker.root ?? "an unknown root"}, not ${root.dir}. ` +
      `Set TT_SUPERVISOR_STATE_DIR to ${marker.root ? path.dirname(marker.root) : "its base"} rather than starting a second one.`);
  }
}

function writeOwnerMarker(root: SupervisorRoot, extra: Record<string, unknown> = {}): void {
  writeFileAtomic(legacyPaths(root.dataDir).marker,
    `${JSON.stringify({ version: 1, root: root.dir, id: root.id, ...extra }, null, 2)}\n`, 0o600);
}

/** What state exists for this data directory. It writes nothing. */
export function inspectSupervisorState(dataDir: string, env: NodeJS.ProcessEnv = process.env): { root: SupervisorRoot; kind: SupervisorStateKind } {
  const root = supervisorRootFor(dataDir, env);
  checkOwnerMarker(root);
  if (readJournal(root)) return { root, kind: "migrating" };
  const record = readRootRecord(root);
  const legacy = hasLegacyState(root.dataDir);
  if (record && legacy) {
    throw new SupervisorStateError(`Supervisor state exists both in ${root.dir} and in ${root.dataDir}. ` +
      "Neither is overwritten; move one aside by hand.");
  }
  if (record) return { root, kind: "ready" };
  // Anything in a root that no record or journal explains is someone's state: never initialized over, never deleted.
  const unknown = unrecordedEntries(root);
  if (unknown.length) {
    throw new SupervisorStateError(`${root.dir} holds ${unknown.slice(0, 3).join(", ")} without a root.json; ` +
      "nothing will be created over or delete it. Move it aside by hand.");
  }
  return { root, kind: legacy ? "legacy" : "none" };
}

/**
 * The root for a command that may write: initializes it when there is no
 * state at all, and refuses while older state waits to be migrated.
 */
export function prepareSupervisorRoot(dataDir: string, env: NodeJS.ProcessEnv = process.env): SupervisorRoot {
  const { root, kind } = inspectSupervisorState(dataDir, env);
  if (kind === "legacy" || kind === "migrating") {
    throw new SupervisorStateError(`Supervisor state in ${root.dataDir} must move to ${root.dir} first: ` +
      "stop the supervisor, then run `tt supervisor migrate`.");
  }
  if (kind === "none") {
    writeRootRecord(root, false);
    writeOwnerMarker(root);
  }
  return root;
}

function writeRootRecord(root: SupervisorRoot, migrated: boolean): void {
  fs.mkdirSync(root.dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(root.dir, 0o700);
  const record: RootRecord = { version: 1, id: root.id, data_dir: root.dataDir, created_at: new Date().toISOString(),
    ...(migrated ? { migrated_from_legacy: true } : {}) };
  writeFileAtomic(path.join(root.dir, ROOT_FILE), `${JSON.stringify(record, null, 2)}\n`, 0o600);
}

export interface MigrationResult { status: "migrated" | "nothing_to_migrate"; root: string; retired?: string }

/**
 * Moves older state into the protected root, while holding both owner locks
 * so no supervisor of either layout runs. The database is copied as one
 * consistent snapshot (VACUUM INTO includes its WAL), verified, and only then
 * is the root marked ready. The old files are kept, moved aside.
 *
 * A journal records the phase. Before the commit, a rerun discards its own
 * partial copy and starts over, the old state untouched. After it, a rerun
 * only finishes moving the old files aside. The old owner lock stays held,
 * at its own path, until that is done.
 */
export interface MigrationGuards {
  /** Takes an owner lock at that path, throwing if a live supervisor holds it. */
  acquireLock(lockPath: string): () => void;
  /** Exact-process liveness, for the old layout's recorded generations. */
  liveness(pid: number, processStartedAt: string): "alive" | "gone" | "unknown";
}

export function migrateSupervisorState(dataDir: string, guards: MigrationGuards,
  env: NodeJS.ProcessEnv = process.env): MigrationResult {
  const { acquireLock } = guards;
  const { root, kind } = inspectSupervisorState(dataDir, env);
  if (kind === "ready" || kind === "none") return { status: "nothing_to_migrate", root: root.dir };
  const legacy = legacyPaths(root.dataDir);
  const journalFile = path.join(root.dir, JOURNAL_FILE);
  const releases: Array<() => void> = [];
  try {
    fs.mkdirSync(root.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(root.dir, 0o700);
    fs.mkdirSync(legacy.dir, { recursive: true, mode: 0o700 });
    releases.push(acquireLock(legacy.lock));
    releases.push(acquireLock(path.join(root.dir, "owner.lock")));
    // Re-read under the locks: what was seen before them may have changed.
    let journal = readJournal(root);
    // Every attempt, a rerun included, checks that nothing may still be running before anything moves.
    requireQuiescent(legacy, path.join(root.dir, "supervisor.sqlite"), guards.liveness);
    if (!journal) {
      if (inspectSupervisorState(dataDir, env).kind !== "legacy") throw new SupervisorStateError(`${root.dir} changed; nothing was migrated.`);
      journal = { version: 1, id: root.id, from: root.dataDir, committed: false, started_at: new Date().toISOString(),
        retired: path.join(root.dataDir, `supervisor-legacy-${new Date().toISOString().replace(/[:.]/g, "-")}`) };
      writeJournal(journalFile, journal);
    }
    if (!journal.committed) {
      // Only this journal's own partial copy is discarded: the root held nothing else when it began.
      for (const entry of fs.readdirSync(root.dir)) {
        if (entry !== "owner.lock" && entry !== JOURNAL_FILE) fs.rmSync(path.join(root.dir, entry), { recursive: true, force: true });
      }
      copyLegacyState(root, legacy);
      // The commit point: from here the root is the state.
      writeRootRecord(root, true);
      journal = { ...journal, committed: true };
      writeJournal(journalFile, journal);
    }
    // Retire the old files: moved aside, never deleted. The old directory keeps
    // only its held lock, so no older supervisor can start in the meantime.
    fs.mkdirSync(journal.retired, { recursive: true, mode: 0o700 });
    for (const file of [legacy.database, `${legacy.database}-wal`, `${legacy.database}-shm`]) {
      if (fs.existsSync(file)) fs.renameSync(file, path.join(journal.retired, path.basename(file)));
    }
    if (fs.existsSync(legacy.dir)) {
      const keep = path.join(journal.retired, "supervisor");
      fs.mkdirSync(keep, { recursive: true, mode: 0o700 });
      for (const entry of fs.readdirSync(legacy.dir)) {
        if (entry !== "owner.lock") fs.renameSync(path.join(legacy.dir, entry), path.join(keep, entry));
      }
    }
    writeOwnerMarker(root, { migrated: { retired: journal.retired, at: new Date().toISOString() } });
    fs.rmSync(journalFile, { force: true });
    return { status: "migrated", root: root.dir, retired: journal.retired };
  } finally {
    for (const release of releases.reverse()) { try { release(); } catch { /* already gone */ } }
    // The old directory held only its lock; remove it once that is released.
    try { fs.rmdirSync(legacy.dir); } catch { /* not empty, or already gone */ }
  }
}

/**
 * Nothing moves while the old layout may still have a running worker. A dead
 * supervisor doesn't prove its children are dead, and a copy taken while one
 * writes would lose what it writes after. Native homes stay put for now: a
 * native session index may record absolute paths that a move would break.
 */
function requireQuiescent(legacy: ReturnType<typeof legacyPaths>, copied: string, liveness: MigrationGuards["liveness"]): void {
  // The old database while it is there; after a commit has moved it aside, the copy holds the same generations.
  const database = fs.existsSync(legacy.database) ? legacy.database : fs.existsSync(copied) ? copied : null;
  if (database) {
    const db = openSqlite(database, { timeout: 5000 });
    try {
      const open = db.prepare("SELECT worker_id, generation, pid, process_started_at FROM generations WHERE ended_at IS NULL")
        .all() as Array<{ worker_id: string; generation: number; pid: number | null; process_started_at: string | null }>;
      for (const row of open) {
        const state = row.pid === null || !row.process_started_at ? "unknown" : liveness(row.pid, row.process_started_at);
        if (state !== "gone") {
          throw new SupervisorStateError(`Worker ${row.worker_id} generation ${row.generation} may still be running (${state}); ` +
            "stop it under the old supervisor before migrating. Nothing was moved.");
        }
      }
    } finally {
      db.close();
    }
  }
  const workers = path.join(legacy.dir, "workers");
  if (!fs.existsSync(workers)) return;
  for (const worker of fs.readdirSync(workers)) {
    for (const home of ["codex", "grok"]) {
      const dir = path.join(workers, worker, home);
      if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
        throw new SupervisorStateError(`${dir} holds native session state, which can't be relocated safely yet. ` +
          "Nothing was moved; remove that worker under the old supervisor first.");
      }
    }
  }
}

function writeJournal(file: string, journal: Journal): void {
  writeFileAtomic(file, JSON.stringify(journal), 0o600);
}

function copyLegacyState(root: SupervisorRoot, legacy: ReturnType<typeof legacyPaths>): void {
  const database = path.join(root.dir, "supervisor.sqlite");
  if (fs.existsSync(legacy.database)) {
    const source = openSqlite(legacy.database, { timeout: 5000 });
    try {
      source.prepare("VACUUM INTO ?").run(`${database}.copy`);
    } finally {
      source.close();
    }
    fs.chmodSync(`${database}.copy`, 0o600);
    verifyCopy(legacy.database, `${database}.copy`);
    fs.renameSync(`${database}.copy`, database);
  }
  // Native homes, process evidence and logs; sockets, the token and locks are made afresh.
  for (const sub of ["workers", "logs"]) {
    const from = path.join(legacy.dir, sub);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(root.dir, sub), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true,
      filter: (source) => !fs.lstatSync(source).isSocket() });
  }
}

/** The copy must hold the same rows as the source, and pass SQLite's own check. */
function verifyCopy(sourcePath: string, copyPath: string): void {
  const source = openSqlite(sourcePath, { timeout: 5000 });
  const copy = openSqlite(copyPath, { timeout: 5000 });
  try {
    const check = copy.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (check.integrity_check !== "ok") throw new SupervisorStateError("The copied supervisor database failed its integrity check.");
    const tables = (source.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>)
      .map((row) => row.name);
    for (const table of tables) {
      const count = (db: typeof source) => (db.prepare(`SELECT COUNT(*) AS n FROM "${table.replace(/"/g, '""')}"`).get() as { n: number }).n;
      if (count(source) !== count(copy)) throw new SupervisorStateError(`The copied supervisor database lost rows in ${table}.`);
    }
  } finally {
    copy.close();
    source.close();
  }
}
