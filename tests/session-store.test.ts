import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  findCliSessionForContextPath,
  readCliSessions,
  resolveCliSessionPath,
  upsertCliSession,
  upsertJoinedCliSession,
  writeCliSessions
} from "../src/session-store.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("CLI session store", () => {
  test("resolves the deepest matching room for the current context path", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-cli-"));
    tempRoots.push(tempRoot);

    const dataDir = path.join(tempRoot, "state");
    const sessionPath = resolveCliSessionPath({ dataDir });
    const repo = createWorkspace(tempRoot, "repo");
    const api = path.join(repo, "packages", "api");
    const apiSrc = path.join(api, "src");
    fs.mkdirSync(apiSrc, { recursive: true });

    upsertCliSession(sessionPath, {
      agent_id: "human:alice",
      room_id: "room-root",
      canonical_path: repo,
      workspace_root: repo,
      updated_at: "2026-04-23T12:00:00.000Z"
    });
    upsertCliSession(sessionPath, {
      agent_id: "human:alice",
      room_id: "room-api",
      canonical_path: api,
      workspace_root: repo,
      updated_at: "2026-04-23T12:05:00.000Z"
    });

    const session = findCliSessionForContextPath(
      sessionPath,
      "human:alice",
      apiSrc
    );

    expect(session?.room_id).toBe("room-api");
  });

  test("stores independent sessions per agent", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-cli-"));
    tempRoots.push(tempRoot);

    const dataDir = path.join(tempRoot, "state");
    const sessionPath = resolveCliSessionPath({ dataDir });
    const repo = createWorkspace(tempRoot, "repo");
    const repoSrc = path.join(repo, "src");
    fs.mkdirSync(repoSrc, { recursive: true });

    upsertCliSession(sessionPath, {
      agent_id: "human:alice",
      room_id: "room-1",
      canonical_path: repo,
      workspace_root: repo,
      updated_at: "2026-04-23T12:00:00.000Z"
    });
    upsertCliSession(sessionPath, {
      agent_id: "human:alex",
      room_id: "room-2",
      canonical_path: repo,
      workspace_root: repo,
      updated_at: "2026-04-23T12:01:00.000Z"
    });

    expect(
      findCliSessionForContextPath(sessionPath, "human:alice", repoSrc)?.room_id
    ).toBe("room-1");
    expect(
      findCliSessionForContextPath(sessionPath, "human:alex", repoSrc)?.room_id
    ).toBe("room-2");
    expect(readCliSessions(sessionPath)).toHaveLength(2);
  });

  test("join refresh preserves an existing lease and guardian for the same room", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-cli-"));
    tempRoots.push(tempRoot);

    const dataDir = path.join(tempRoot, "state");
    const sessionPath = resolveCliSessionPath({ dataDir });
    const repo = createWorkspace(tempRoot, "repo");

    upsertCliSession(sessionPath, {
      agent_id: "human:alice",
      room_id: "room-1",
      canonical_path: repo,
      workspace_root: repo,
      lease_id: "lease-1",
      turn_id: 7,
      guardian_pid: 4242,
      guardian_process_started_at: "Thu Apr 23 19:22:02 2026",
      updated_at: "2026-04-23T12:00:00.000Z"
    });

    upsertJoinedCliSession(sessionPath, {
      agent_id: "human:alice",
      room_id: "room-1",
      canonical_path: repo,
      workspace_root: repo,
      updated_at: "2026-04-23T12:05:00.000Z"
    });

    expect(readCliSessions(sessionPath)).toEqual([
      {
        agent_id: "human:alice",
        room_id: "room-1",
        canonical_path: repo,
        workspace_root: repo,
        lease_id: "lease-1",
        turn_id: 7,
        guardian_pid: 4242,
        guardian_process_started_at: "Thu Apr 23 19:22:02 2026",
        updated_at: "2026-04-23T12:05:00.000Z"
      }
    ]);
  });

  test("writes session files with an atomic rename", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-cli-"));
    tempRoots.push(tempRoot);

    const sessionPath = path.join(tempRoot, "state", "cli-sessions.json");
    const renameSpy = vi.spyOn(fs, "renameSync");

    writeCliSessions(sessionPath, [
      {
        agent_id: "human:alice",
        room_id: "room-1",
        canonical_path: "/repo",
        workspace_root: "/repo",
        updated_at: "2026-04-23T12:00:00.000Z"
      }
    ]);

    expect(renameSpy).toHaveBeenCalledWith(
      expect.stringContaining(".cli-sessions.json."),
      sessionPath
    );
    expect(readCliSessions(sessionPath)).toHaveLength(1);
  });

  test("cursor updates are monotonic when wait processes finish out of order", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-cli-"));
    tempRoots.push(tempRoot);
    const sessionPath = path.join(tempRoot, "state", "cli-sessions.json");
    const base = {
      agent_id: "human:alice",
      room_id: "room-1",
      canonical_path: "/repo",
      workspace_root: "/repo"
    };

    upsertCliSession(sessionPath, {
      ...base,
      event_cursor_seq: 20,
      updated_at: "2026-04-23T12:00:00.000Z"
    });
    upsertCliSession(sessionPath, {
      ...base,
      event_cursor_seq: 10,
      updated_at: "2026-04-23T12:01:00.000Z"
    });

    expect(readCliSessions(sessionPath)[0].event_cursor_seq).toBe(20);
  });
});

function createWorkspace(tempRoot: string, name: string): string {
  const repo = path.join(tempRoot, name);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "package.json"), "{}\n");
  return fs.realpathSync.native(repo);
}
