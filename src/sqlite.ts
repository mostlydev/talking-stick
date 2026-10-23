import { createRequire } from "node:module";
import type BetterSqlite3 from "better-sqlite3";

// The store speaks better-sqlite3's API. Under Node that is the real driver;
// under Bun (the standalone binary) a thin wrapper over bun:sqlite provides
// the subset this codebase uses, because better-sqlite3's native addon cannot
// load from a compiled executable.
export type SqliteDatabase = BetterSqlite3.Database;

export interface OpenSqliteOptions {
  /** Fail instead of creating the file when it does not exist. */
  fileMustExist?: boolean;
  /** Busy timeout in milliseconds applied when the database opens. */
  timeout?: number;
}

const requireModule = createRequire(import.meta.url);

export function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

export function openSqlite(file: string, options: OpenSqliteOptions = {}): SqliteDatabase {
  if (!isBunRuntime()) {
    const Database = requireModule("better-sqlite3") as typeof BetterSqlite3;
    // better-sqlite3 rejects options that are present but undefined.
    return new Database(file, {
      ...(options.fileMustExist !== undefined ? { fileMustExist: options.fileMustExist } : {}),
      ...(options.timeout !== undefined ? { timeout: options.timeout } : {})
    });
  }
  const { Database } = requireModule("bun:sqlite") as { Database: BunDatabaseConstructor };
  // strict: a missing bind throws, as in better-sqlite3, instead of binding NULL.
  const db = new Database(file, { strict: true, readwrite: true, create: !options.fileMustExist });
  if (options.timeout !== undefined) db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.timeout))}`);
  return wrapBunDatabase(db);
}

interface BunStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface BunDatabase {
  readonly inTransaction: boolean;
  prepare(sql: string): BunStatement;
  exec(sql: string): void;
  close(): void;
}

type BunDatabaseConstructor = new (file: string, options?: { strict?: boolean; readwrite?: boolean; create?: boolean }) => BunDatabase;

// bun:sqlite returns null for a missing row where better-sqlite3 returns
// undefined, and takes `PRAGMA` through exec/query rather than pragma().
export function wrapBunDatabase(db: BunDatabase): SqliteDatabase {
  const prepare = (sql: string) => {
    const statement = db.prepare(sql);
    return {
      run: (...params: unknown[]) => {
        const result = statement.run(...params);
        return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
      },
      get: (...params: unknown[]) => statement.get(...params) ?? undefined,
      all: (...params: unknown[]) => statement.all(...params)
    };
  };
  const wrapper = {
    prepare,
    get inTransaction() {
      return db.inTransaction;
    },
    exec(sql: string) {
      db.exec(sql);
      return wrapper;
    },
    pragma(source: string) {
      return db.prepare(`PRAGMA ${source}`).all();
    },
    close() {
      db.close();
      return wrapper;
    }
  };
  return wrapper as unknown as SqliteDatabase;
}
