import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  findCliSessionForContextPath,
  readCliSessions,
  resolveCliSessionPath,
  upsertCliSession
} from "../src/session-store.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
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
      agent_id: "human:wojtek",
      room_id: "room-root",
      canonical_path: repo,
      workspace_root: repo,
      updated_at: "2026-04-23T12:00:00.000Z"
    });
    upsertCliSession(sessionPath, {
      agent_id: "human:wojtek",
      room_id: "room-api",
      canonical_path: api,
      workspace_root: repo,
      updated_at: "2026-04-23T12:05:00.000Z"
    });

    const session = findCliSessionForContextPath(
      sessionPath,
      "human:wojtek",
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
      agent_id: "human:wojtek",
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
      findCliSessionForContextPath(sessionPath, "human:wojtek", repoSrc)?.room_id
    ).toBe("room-1");
    expect(
      findCliSessionForContextPath(sessionPath, "human:alex", repoSrc)?.room_id
    ).toBe("room-2");
    expect(readCliSessions(sessionPath)).toHaveLength(2);
  });
});

function createWorkspace(tempRoot: string, name: string): string {
  const repo = path.join(tempRoot, name);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "package.json"), "{}\n");
  return fs.realpathSync.native(repo);
}
