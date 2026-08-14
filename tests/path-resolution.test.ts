import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  resolveContextPath,
  TalkingStickService
} from "../src/index.js";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempRoots: string[] = [];
const services: TalkingStickService[] = [];

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }

  for (const service of services.splice(0)) {
    service.close();
  }

  for (const tempRoot of tempRoots.splice(0)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe("path resolution", () => {
  test("ignores home-level workspace markers for markerless child paths", () => {
    const { home } = createTempHome();
    const scratch = path.join(home, "dev", "scratch");
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(path.join(home, "package.json"), "{}\n");

    const resolved = resolveContextPath(scratch);

    expect(resolved.canonical_context_path).toBe(realPath(scratch));
    expect(resolved.workspace_root).toBe(realPath(scratch));
  });

  test("still resolves explicit home paths to home", () => {
    const { home } = createTempHome();
    fs.writeFileSync(path.join(home, "package.json"), "{}\n");

    const resolved = resolveContextPath(home);

    expect(resolved.canonical_context_path).toBe(realPath(home));
    expect(resolved.workspace_root).toBe(realPath(home));
  });

  test("uses nested project markers below home before the home boundary", () => {
    const { home } = createTempHome();
    fs.writeFileSync(path.join(home, "package.json"), "{}\n");

    const project = path.join(home, "dev", "project");
    const nested = path.join(project, "packages", "api", "src");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(project, "AGENTS.md"), "# Agents\n");

    const resolved = resolveContextPath(nested);

    expect(resolved.canonical_context_path).toBe(realPath(nested));
    expect(resolved.workspace_root).toBe(realPath(project));
  });

  test("join_path from a markerless child does not attach to an existing home room", () => {
    const { home, tempRoot } = createTempHome();
    fs.writeFileSync(path.join(home, "package.json"), "{}\n");

    const scratch = path.join(home, "dev", "scratch");
    fs.mkdirSync(scratch, { recursive: true });
    const service = new TalkingStickService({
      dbPath: path.join(tempRoot, "state", "rooms.sqlite")
    });
    services.push(service);

    const homeJoin = service.joinPath({
      agent_id: "codex:home",
      context_path: home
    });
    const scratchJoin = service.joinPath({
      agent_id: "claude:scratch",
      context_path: scratch
    });

    expect(homeJoin.canonical_path).toBe(realPath(home));
    expect(scratchJoin.room_id).not.toBe(homeJoin.room_id);
    expect(scratchJoin.canonical_path).toBe(realPath(scratch));
    expect(scratchJoin.workspace_root).toBe(realPath(scratch));
    expect(scratchJoin.joined_existing_room).toBe(false);
  });

  test("a nested project root still joins an existing parent room", () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "talking-stick-parent-")
    );
    tempRoots.push(tempRoot);
    const parent = path.join(tempRoot, "umbrella");
    const nestedProject = path.join(parent, "repos", "child");
    fs.mkdirSync(nestedProject, { recursive: true });
    fs.writeFileSync(path.join(parent, "package.json"), "{}\n");
    fs.writeFileSync(path.join(nestedProject, "package.json"), "{}\n");

    const service = new TalkingStickService({
      dbPath: path.join(tempRoot, "state", "rooms.sqlite")
    });
    services.push(service);

    const parentJoin = service.joinPath({
      agent_id: "claude:parent",
      context_path: parent
    });
    const nestedJoin = service.joinPath({
      agent_id: "codex:child",
      context_path: nestedProject
    });

    expect(resolveContextPath(nestedProject).workspace_root).toBe(
      realPath(nestedProject)
    );
    expect(nestedJoin.room_id).toBe(parentJoin.room_id);
    expect(nestedJoin.canonical_path).toBe(realPath(parent));
    expect(nestedJoin.members.map((member) => member.agent_id).sort()).toEqual([
      "claude:parent",
      "codex:child"
    ]);
    expect(
      service.listRooms({ context_path: nestedProject }).rooms
    ).toHaveLength(1);
    expect(
      service.getRoomHealth({
        agent_id: "codex:child",
        context_path: nestedProject
      }).room.room_id
    ).toBe(parentJoin.room_id);

    const explicitNested = path.join(parent, "repos", "isolated");
    fs.mkdirSync(explicitNested, { recursive: true });
    fs.writeFileSync(path.join(explicitNested, "package.json"), "{}\n");
    const forced = service.joinPath({
      agent_id: "grok:isolated",
      context_path: explicitNested,
      force_new: true
    });
    expect(forced.room_id).not.toBe(parentJoin.room_id);
    expect(forced.canonical_path).toBe(realPath(explicitNested));
    expect(forced.warning).toContain("Created nested room inside");
  });
});

function createTempHome(): { home: string; tempRoot: string } {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-path-"));
  tempRoots.push(tempRoot);
  const home = path.join(tempRoot, "home");
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return { home: realPath(home), tempRoot };
}

function realPath(filePath: string): string {
  return fs.realpathSync.native(filePath);
}
