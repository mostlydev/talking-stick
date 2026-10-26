import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { openSqlite } from "../src/sqlite.js";
import { canonicalPath, inspectSupervisorState, legacyPaths, migrateSupervisorState, prepareSupervisorRoot,
  supervisorRootFor, supervisorStateBase } from "../src/supervisor/root.js";
import { SupervisorStore } from "../src/supervisor/state.js";
import { LAUNCHD_LABEL } from "../src/supervisor/launchd.js";
import { handleSupervisorCommand } from "../src/cli/supervisor-commands.js";
import type { ParsedCommand } from "../src/cli/parser.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); vi.unstubAllEnvs(); });

function dirs() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tt-root-"));
  // A short base keeps UNIX socket paths in bounds; Windows has no /tmp.
  const state = fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "tt-rs-"));
  cleanup.push(() => { fs.rmSync(base, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true }); });
  const dataDir = path.join(base, "data");
  fs.mkdirSync(dataDir);
  return { base, dataDir, env: { ...process.env, TT_SUPERVISOR_STATE_DIR: state } as NodeJS.ProcessEnv, state };
}

/** Older state, as a supervisor before this change left it: the DB beside the data, a subtree with homes and logs. */
function legacyState(dataDir: string, options: { keepWriterOpen?: boolean } = {}) {
  const legacy = legacyPaths(dataDir);
  const store = new SupervisorStore(legacy.database);
  store.addWorker({ worker_id: "w1", harness: "codex", cwd: dataDir, permissions: { harness: "codex", sandbox: "read-only", approval: "on-request" },
    env: [] }, "human:op", "t");
  // Rows only in the WAL: the copy must still carry them.
  store.db.pragma("wal_autocheckpoint = 0");
  store.addWorker({ worker_id: "w2", harness: "claude", cwd: dataDir, permissions: { harness: "claude", mode: "default" }, env: [] }, "human:op", "t");
  fs.mkdirSync(path.join(legacy.dir, "workers", "w1", "codex", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(legacy.dir, "workers", "w1", "codex", "sessions", "thread.jsonl"), "native history\n", { mode: 0o600 });
  fs.mkdirSync(path.join(legacy.dir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(legacy.dir, "logs", "daemon.log"), "old log\n");
  fs.writeFileSync(path.join(legacy.dir, "control.token"), "old-token");
  if (options.keepWriterOpen) cleanup.push(() => store.close()); else store.close();
  return legacy;
}

const noLock = () => () => {};

describe("where supervisor state lives", () => {
  test("the base is an explicit absolute override, or the platform's user state directory", () => {
    expect(() => supervisorStateBase({ TT_SUPERVISOR_STATE_DIR: "relative" })).toThrow("absolute");
    expect(supervisorStateBase({ HOME: "/Users/u" }, "darwin")).toBe("/Users/u/Library/Application Support/talking-stick/supervisor");
    expect(supervisorStateBase({ HOME: "/home/u", XDG_STATE_HOME: "/xdg" }, "linux")).toBe("/xdg/talking-stick/supervisor");
    expect(supervisorStateBase({ HOME: "/home/u", XDG_STATE_HOME: "relative" }, "linux")).toBe("/home/u/.local/state/talking-stick/supervisor");
  });

  test("a path that doesn't exist yet resolves through its nearest existing ancestor, and aliases share one root", () => {
    const { base, dataDir, env } = dirs();
    fs.symlinkSync(dataDir, path.join(base, "alias"));
    expect(canonicalPath(path.join(base, "alias", "not", "yet"))).toBe(path.join(fs.realpathSync(dataDir), "not", "yet"));
    expect(supervisorRootFor(path.join(base, "alias"), env)).toEqual(supervisorRootFor(dataDir, env));
    expect(supervisorRootFor(dataDir, env).dir.startsWith(fs.realpathSync(env.TT_SUPERVISOR_STATE_DIR!))).toBe(true);
  });

  test("a root too long for its sockets is refused, naming the override", () => {
    const { dataDir } = dirs();
    expect(() => supervisorRootFor(dataDir, { TT_SUPERVISOR_STATE_DIR: `/tmp/${"x".repeat(90)}` })).toThrow("TT_SUPERVISOR_STATE_DIR");
  });

  test("a root is initialized once, and one recorded for another data directory is refused", () => {
    const { base, dataDir, env } = dirs();
    expect(inspectSupervisorState(dataDir, env).kind).toBe("none");
    const root = prepareSupervisorRoot(dataDir, env);
    expect(fs.statSync(root.dir).mode & 0o777).toBe(0o700);
    expect(inspectSupervisorState(dataDir, env).kind).toBe("ready");
    expect(fs.existsSync(path.join(dataDir, "supervisor"))).toBe(false);
    // A copied root never serves a different directory.
    const other = path.join(base, "other");
    fs.mkdirSync(other);
    const otherRoot = supervisorRootFor(other, env);
    fs.cpSync(root.dir, otherRoot.dir, { recursive: true });
    expect(() => inspectSupervisorState(other, env)).toThrow("belongs to");
  });
});

describe("older state in the data directory", () => {
  test("blocks every writing path, and reading creates nothing, until it is migrated", () => {
    const { dataDir, env } = dirs();
    legacyState(dataDir);
    expect(inspectSupervisorState(dataDir, env).kind).toBe("legacy");
    expect(() => prepareSupervisorRoot(dataDir, env)).toThrow("tt supervisor migrate");
    expect(fs.existsSync(supervisorRootFor(dataDir, env).dir)).toBe(false);
  });

  test("migration copies the database with its WAL, the homes and the logs, keeps the old files, and is not repeated", () => {
    const { dataDir, env } = dirs();
    const legacy = legacyState(dataDir, { keepWriterOpen: true });
    expect(fs.existsSync(`${legacy.database}-wal`)).toBe(true);
    const result = migrateSupervisorState(dataDir, noLock, env);
    expect(result.status).toBe("migrated");
    const root = supervisorRootFor(dataDir, env);
    const moved = new SupervisorStore(path.join(root.dir, "supervisor.sqlite"));
    cleanup.push(() => moved.close());
    expect(moved.workers().map((worker) => worker.worker_id).sort()).toEqual(["w1", "w2"]);
    expect(fs.readFileSync(path.join(root.dir, "workers", "w1", "codex", "sessions", "thread.jsonl"), "utf8")).toBe("native history\n");
    expect(fs.readFileSync(path.join(root.dir, "logs", "daemon.log"), "utf8")).toBe("old log\n");
    // The token is made afresh by the next daemon, never carried over.
    expect(fs.existsSync(path.join(root.dir, "control.token"))).toBe(false);
    expect(fs.statSync(path.join(root.dir, "supervisor.sqlite")).mode & 0o777).toBe(0o600);
    // The old files are kept aside, and the data directory no longer holds supervisor state.
    expect(fs.existsSync(legacy.database)).toBe(false);
    expect(fs.existsSync(legacy.dir)).toBe(false);
    expect(fs.existsSync(path.join(result.retired!, "supervisor.sqlite"))).toBe(true);
    expect(fs.existsSync(path.join(result.retired!, "supervisor", "workers", "w1", "codex", "sessions", "thread.jsonl"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(legacy.tombstone, "utf8"))).toMatchObject({ root: root.dir, retired: result.retired });
    expect(inspectSupervisorState(dataDir, env).kind).toBe("ready");
    expect(migrateSupervisorState(dataDir, noLock, env).status).toBe("nothing_to_migrate");
  });

  test("a supervisor holding either lock stops the migration before anything moves", () => {
    const { dataDir, env } = dirs();
    const legacy = legacyState(dataDir);
    const root = supervisorRootFor(dataDir, env);
    for (const held of [legacyPaths(root.dataDir).lock, path.join(root.dir, "owner.lock")]) {
      expect(() => migrateSupervisorState(dataDir, (lock) => {
        if (lock === held) throw new Error("Another supervisor owns it.");
        return () => {};
      }, env)).toThrow("Another supervisor");
      expect(fs.existsSync(legacy.database)).toBe(true);
      expect(fs.existsSync(path.join(supervisorRootFor(dataDir, env).dir, "root.json"))).toBe(false);
    }
  });

  test("a migration interrupted before its commit is refused everywhere, then redone from the untouched old state", () => {
    const { dataDir, env } = dirs();
    const legacy = legacyState(dataDir);
    const root = supervisorRootFor(dataDir, env);
    fs.mkdirSync(root.dir, { recursive: true });
    fs.writeFileSync(path.join(root.dir, "migration.json"), JSON.stringify({ version: 1, id: root.id, from: root.dataDir, committed: false,
      retired: path.join(root.dataDir, "supervisor-legacy-2026-10-26T01-00-00-000Z"), started_at: "t" }));
    fs.writeFileSync(path.join(root.dir, "supervisor.sqlite"), "half a copy");
    expect(inspectSupervisorState(dataDir, env).kind).toBe("migrating");
    expect(() => prepareSupervisorRoot(dataDir, env)).toThrow("tt supervisor migrate");
    expect(migrateSupervisorState(dataDir, noLock, env).status).toBe("migrated");
    const moved = new SupervisorStore(path.join(root.dir, "supervisor.sqlite"));
    cleanup.push(() => moved.close());
    expect(moved.workers()).toHaveLength(2);
    expect(fs.existsSync(legacy.database)).toBe(false);
  });

  test("a migration interrupted after its commit only finishes retiring the old files, keeping the new state", () => {
    const { dataDir, env } = dirs();
    const legacy = legacyState(dataDir);
    const root = supervisorRootFor(dataDir, env);
    fs.mkdirSync(root.dir, { recursive: true });
    // The committed copy has a row the old database lacks: a rerun must not copy over it.
    const committed = new SupervisorStore(path.join(root.dir, "supervisor.sqlite"));
    committed.addWorker({ worker_id: "after", harness: "claude", cwd: dataDir, permissions: { harness: "claude", mode: "default" }, env: [] }, "human:op", "t");
    committed.close();
    fs.writeFileSync(path.join(root.dir, "root.json"), JSON.stringify({ version: 1, id: root.id, data_dir: root.dataDir,
      created_at: "t", migrated_from_legacy: true }));
    const retired = path.join(root.dataDir, "supervisor-legacy-2026-10-26T01-00-00-000Z");
    fs.writeFileSync(path.join(root.dir, "migration.json"), JSON.stringify({ version: 1, id: root.id, from: root.dataDir, committed: true, retired, started_at: "t" }));
    expect(migrateSupervisorState(dataDir, noLock, env)).toMatchObject({ status: "migrated", retired });
    const kept = new SupervisorStore(path.join(root.dir, "supervisor.sqlite"));
    cleanup.push(() => kept.close());
    expect(kept.workers().map((worker) => worker.worker_id)).toEqual(["after"]);
    expect(fs.existsSync(path.join(retired, "supervisor.sqlite"))).toBe(true);
    expect(fs.existsSync(legacy.dir)).toBe(false);
    expect(inspectSupervisorState(dataDir, env).kind).toBe("ready");
  });

  test("a second lock that fails releases the first", () => {
    const { dataDir, env } = dirs();
    legacyState(dataDir);
    let calls = 0;
    const released: number[] = [];
    expect(() => migrateSupervisorState(dataDir, () => {
      const call = ++calls;
      if (call === 2) throw new Error("new root busy");
      return () => { released.push(call); };
    }, env)).toThrow("new root busy");
    expect(released).toEqual([1]);
  });

  test("the old lock is held until the old files are retired and the tombstone written", () => {
    const { dataDir, env } = dirs();
    const legacy = legacyState(dataDir);
    const canonical = legacyPaths(supervisorRootFor(dataDir, env).dataDir);
    const seen: Array<{ tombstone: boolean; lockStillThere: boolean }> = [];
    migrateSupervisorState(dataDir, (lock) => {
      fs.writeFileSync(lock, "held");
      return () => {
        if (lock === canonical.lock) seen.push({ tombstone: fs.existsSync(legacy.tombstone), lockStillThere: fs.existsSync(lock) });
        fs.rmSync(lock, { force: true });
      };
    }, env);
    expect(seen).toEqual([{ tombstone: true, lockStillThere: true }]);
    expect(fs.existsSync(legacy.dir)).toBe(false);
  });

  test("a root holding state no record explains is refused, and nothing in it is deleted", () => {
    const { dataDir, env } = dirs();
    legacyState(dataDir);
    const root = supervisorRootFor(dataDir, env);
    fs.mkdirSync(root.dir, { recursive: true });
    const valuable = path.join(root.dir, "supervisor.sqlite");
    fs.writeFileSync(valuable, "existing unknown supervisor state");
    expect(() => migrateSupervisorState(dataDir, noLock, env)).toThrow("without a root.json");
    expect(() => prepareSupervisorRoot(dataDir, env)).toThrow("without a root.json");
    expect(fs.readFileSync(valuable, "utf8")).toBe("existing unknown supervisor state");
  });

  test("a journal for another root, an odd retirement path, or a phase the root contradicts is refused", () => {
    const { dataDir, env } = dirs();
    legacyState(dataDir);
    const root = supervisorRootFor(dataDir, env);
    fs.mkdirSync(root.dir, { recursive: true });
    const good = { version: 1, id: root.id, from: root.dataDir, committed: false,
      retired: path.join(root.dataDir, "supervisor-legacy-2026-10-26T01-00-00-000Z"), started_at: "t" };
    for (const journal of [{ ...good, id: "0".repeat(16) }, { ...good, from: "/elsewhere" }, { ...good, retired: "/etc/supervisor-legacy-x" },
      { ...good, retired: path.join(root.dataDir, "anything") }, { ...good, committed: true }]) {
      fs.writeFileSync(path.join(root.dir, "migration.json"), JSON.stringify(journal));
      expect(() => migrateSupervisorState(dataDir, noLock, env)).toThrow();
      expect(fs.existsSync(legacyPaths(root.dataDir).database)).toBe(true);
    }
  });

  test("state in both places is never merged or overwritten", () => {
    const { dataDir, env } = dirs();
    prepareSupervisorRoot(dataDir, env);
    const legacy = legacyState(dataDir);
    expect(() => inspectSupervisorState(dataDir, env)).toThrow("both");
    expect(() => migrateSupervisorState(dataDir, noLock, env)).toThrow("both");
    expect(fs.existsSync(legacy.database)).toBe(true);
  });
});

describe("tt supervisor migrate", () => {
  function cli(dataDir: string, env: NodeJS.ProcessEnv) {
    vi.stubEnv("TALKING_STICK_DATA_DIR", dataDir);
    vi.stubEnv("TT_SUPERVISOR_STATE_DIR", env.TT_SUPERVISOR_STATE_DIR!);
    for (const key of ["CLAUDECODE", "CODEX_THREAD_ID", "CODEX_MANAGED_BY_NPM", "GEMINI_CLI", "OPENCODE", "TT_HARNESS_AGENT_ID"]) vi.stubEnv(key, "");
    const output: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { output.push(String(chunk)); return true; });
    cleanup.push(() => write.mockRestore());
    return async (args: string[], inside: string | null = null) => {
      output.length = 0;
      const parsed: ParsedCommand = { name: "supervisor", positionals: args, options: new Map<string, string | true>([["json", true]]) };
      await handleSupervisorCommand(parsed, { insideHarness: () => inside });
      return output.length ? JSON.parse(output.join("")) : null;
    };
  }

  test("reading or adding before migration is refused and creates nothing; a human migrates, then it works", async () => {
    const { base, dataDir, env } = dirs();
    vi.stubEnv("HOME", base);
    legacyState(dataDir);
    const run = cli(dataDir, env);
    await expect(run(["status"])).rejects.toThrow("tt supervisor migrate");
    await expect(run(["add", "w3"])).rejects.toThrow("tt supervisor migrate");
    expect(fs.existsSync(supervisorRootFor(dataDir, env).dir)).toBe(false);
    await expect(run(["migrate"], "codex")).rejects.toThrow("not a codex session");
    expect(await run(["migrate"])).toMatchObject({ status: "migrated" });
    expect((await run(["status"])).workers.map((w: { worker_id: string }) => w.worker_id).sort()).toEqual(["w1", "w2"]);
  });

  test("with the user agent installed, migration waits for it to be uninstalled", async () => {
    const { base, dataDir, env } = dirs();
    vi.stubEnv("HOME", base);
    legacyState(dataDir);
    fs.mkdirSync(path.join(base, "Library", "LaunchAgents"), { recursive: true });
    fs.writeFileSync(path.join(base, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`), "<plist/>");
    const run = cli(dataDir, env);
    await expect(run(["migrate"])).rejects.toThrow("uninstall");
    expect(fs.existsSync(legacyPaths(dataDir).database)).toBe(true);
  });

  test("status, a locked control or an unknown action with no state at all creates nothing", async () => {
    const { dataDir, env } = dirs();
    const run = cli(dataDir, env);
    expect(await run(["status"])).toEqual({ workers: [], pending_approvals: [] });
    for (const args of [["approve", "a1"], ["deny", "a1"], ["interrupt", "w1"], ["reconcile", "b1"], ["frobnicate"]]) {
      await expect(run(args)).rejects.toThrow();
    }
    expect(fs.existsSync(supervisorRootFor(dataDir, env).dir)).toBe(false);
  });
});

test("a WAL-only row survives even when SQLite never checkpointed it", () => {
  // Guards the premise of the migration test above.
  const { dataDir } = dirs();
  const db = openSqlite(path.join(dataDir, "x.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("wal_autocheckpoint = 0");
  db.exec("CREATE TABLE t (v); INSERT INTO t VALUES (1)");
  db.prepare("VACUUM INTO ?").run(path.join(dataDir, "y.sqlite"));
  db.close();
  const copy = openSqlite(path.join(dataDir, "y.sqlite"));
  expect(copy.prepare("SELECT COUNT(*) AS n FROM t").get()).toEqual({ n: 1 });
  copy.close();
});
