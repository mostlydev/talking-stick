// Runs under `bun test` (npm run test:bun): exercises the bun:sqlite wrapper
// that the standalone binary uses, which the Node/Vitest suite never loads.
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openSqlite } from "../../src/sqlite.js";
import { openDatabase, withImmediateTransaction } from "../../src/db.js";

const roots: string[] = [];
const tempFile = (name: string) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-bun-sqlite-"));
  roots.push(root);
  return path.join(root, name);
};
// close() defers until unfinalized statements are collected, and Windows
// cannot remove a database file that is still open.
afterEach(() => {
  Bun.gc(true);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("missing rows are undefined, runs report changes, pragma returns rows", () => {
  const db = openSqlite(tempFile("a.sqlite"));
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); CREATE INDEX t_name ON t(name);");
  const insert = db.prepare("INSERT INTO t (name) VALUES (?)").run("one");
  expect(insert.changes).toBe(1);
  expect(Number(insert.lastInsertRowid)).toBe(1);
  expect(db.prepare("SELECT name FROM t WHERE id = ?").get(1)).toEqual({ name: "one" });
  expect(db.prepare("SELECT name FROM t WHERE id = ?").get(99)).toBeUndefined();
  expect(db.prepare("SELECT name FROM t").all()).toEqual([{ name: "one" }]);
  expect(db.pragma("journal_mode = WAL")).toEqual([{ journal_mode: "wal" }]);
  db.close();
});

test("a missing bind throws instead of binding NULL", () => {
  const db = openSqlite(tempFile("b.sqlite"));
  db.exec("CREATE TABLE t (a TEXT, b TEXT)");
  expect(() => db.prepare("INSERT INTO t VALUES (?, ?)").run("only one")).toThrow();
  db.close();
});

test("fileMustExist refuses to create a database", () => {
  expect(() => openSqlite(tempFile("missing.sqlite"), { fileMustExist: true })).toThrow();
});

test("busy timeout waits for a writer instead of failing at once", () => {
  const file = tempFile("busy.sqlite");
  const writer = openSqlite(file);
  writer.exec("CREATE TABLE t (x INTEGER)");
  writer.exec("BEGIN IMMEDIATE");
  const reader = openSqlite(file, { timeout: 50 });
  const started = Date.now();
  expect(() => reader.prepare("INSERT INTO t VALUES (1)").run()).toThrow();
  expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  writer.exec("ROLLBACK");
  writer.close();
  reader.close();
});

test("the real schema migrates and immediate transactions roll back on error", () => {
  const db = openDatabase({ dbPath: tempFile("rooms.sqlite") });
  expect(db.prepare("SELECT count(*) AS n FROM path_rooms").get()).toEqual({ n: 0 });
  expect(() => withImmediateTransaction(db, () => {
    db.prepare("INSERT INTO notes_probe_missing VALUES (1)").run();
  })).toThrow();
  // A failed transaction leaves the connection usable.
  expect(withImmediateTransaction(db, () => 7)).toBe(7);
  db.close();
});
