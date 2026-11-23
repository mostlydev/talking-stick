import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { applyPendingMigrations, migrate, openDatabase } from "../src/db.js";
import { TalkingStickService } from "../src/service.js";
import { RENAME_NOTICE_ID, RENAME_NOTICE_TEXT, profileNoticeAllowed } from "../src/profile-notices.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempDb(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-notices-"));
  tempRoots.push(root);
  return path.join(root, "rooms.sqlite");
}

// Rewind a database to just before migration 33, as an install from 0.37.0 has it.
function rewindToBeforeNotices(dbPath: string): void {
  const db = openDatabase({ dbPath });
  db.exec("DROP TABLE profile_notices; DELETE FROM schema_migrations WHERE id = 33;");
  db.close();
}

const pending = (dbPath: string) => {
  const db = openDatabase({ dbPath });
  try {
    return db.prepare("SELECT notice_id, shown_at FROM profile_notices").all();
  } finally {
    db.close();
  }
};

describe("profile notices", () => {
  test("a new profile never gets the rename notice", () => {
    const dbPath = tempDb();
    openDatabase({ dbPath }).close();
    expect(pending(dbPath)).toEqual([]);
  });

  test("an upgraded profile gets the rename notice once, and re-running migrations adds nothing", () => {
    const dbPath = tempDb();
    openDatabase({ dbPath }).close();
    rewindToBeforeNotices(dbPath);
    expect(pending(dbPath)).toEqual([{ notice_id: RENAME_NOTICE_ID, shown_at: null }]);
    const db = openDatabase({ dbPath });
    migrate(db);
    db.close();
    expect(pending(dbPath)).toHaveLength(1);
  });

  test("a launch whose migration snapshot went stale skips what another process already applied", () => {
    const dbPath = tempDb();
    openDatabase({ dbPath }).close();
    rewindToBeforeNotices(dbPath);
    // Two first launches after an upgrade: both read the applied list before
    // either takes the write lock. The first applies 33; the second must not
    // try to create the table again or add a second notice.
    const first = openDatabase({ dbPath });
    const db = openDatabase({ dbPath });
    try {
      const stale = new Set((db.prepare("SELECT id FROM schema_migrations").all() as Array<{ id: number }>)
        .map((row) => row.id).filter((id) => id !== 33));
      expect(() => applyPendingMigrations(db, stale)).not.toThrow();
      expect(() => applyPendingMigrations(db, new Set())).not.toThrow();
    } finally {
      db.close();
      first.close();
    }
    expect(pending(dbPath)).toEqual([{ notice_id: RENAME_NOTICE_ID, shown_at: null }]);
  });

  test("exactly one of several terminals on the same profile shows it", () => {
    const dbPath = tempDb();
    openDatabase({ dbPath }).close();
    rewindToBeforeNotices(dbPath);
    const first = new TalkingStickService({ dbPath });
    const second = new TalkingStickService({ dbPath });
    try {
      expect(first.claimProfileNotices()).toEqual([RENAME_NOTICE_TEXT]);
      expect(second.claimProfileNotices()).toEqual([]);
      expect(first.claimProfileNotices()).toEqual([]);
    } finally {
      first.close();
      second.close();
    }
  });

  test("only a person at a terminal sees a notice, never JSON, hooks, chat, or a harness", () => {
    const human = { json: false, stdoutTTY: true, stderrTTY: true, internal: false, command: "state", insideHarness: () => null };
    expect(profileNoticeAllowed(human)).toBe(true);
    expect(profileNoticeAllowed({ ...human, json: true })).toBe(false);
    expect(profileNoticeAllowed({ ...human, stdoutTTY: false })).toBe(false);
    expect(profileNoticeAllowed({ ...human, stderrTTY: false })).toBe(false);
    expect(profileNoticeAllowed({ ...human, internal: true })).toBe(false);
    expect(profileNoticeAllowed({ ...human, command: "chat" })).toBe(false);
    expect(profileNoticeAllowed({ ...human, insideHarness: () => "claude" })).toBe(false);
  });
});
