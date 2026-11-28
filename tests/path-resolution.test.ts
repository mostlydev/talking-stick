import { execFileSync } from "node:child_process";
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

  test("a declared package is its own room inside a monorepo", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-mono-"));
    tempRoots.push(tempRoot);
    const repo = createRepo(tempRoot);
    const api = path.join(repo, "packages", "api");
    declareRoom(api);
    const service = new TalkingStickService({ dbPath: path.join(tempRoot, "state", "rooms.sqlite") });
    services.push(service);

    const resolved = resolveContextPath(path.join(api, "src"));
    expect(resolved.declaration).toEqual({ directory: realPath(api), rel_path: "packages/api", name: "api", id: null, problem: null });
    expect(resolved.room_path).toBe(realPath(api));

    const root = service.joinPath({ agent_id: "claude:root", context_path: repo });
    const apiJoin = service.joinPath({ agent_id: "codex:api", context_path: path.join(api, "src") });
    const webJoin = service.joinPath({ agent_id: "grok:web", context_path: path.join(repo, "packages", "web") });
    expect(apiJoin.room_id).not.toBe(root.room_id);
    expect(apiJoin.canonical_path).toBe(realPath(api));
    expect(webJoin.room_id).toBe(root.room_id);
    expect(service.joinPath({ agent_id: "codex:api2", context_path: api }).room_id).toBe(apiJoin.room_id);
    expect(service.getRoomHealth({ agent_id: "codex:api", context_path: path.join(api, "src") }).room.room_id)
      .toBe(apiJoin.room_id);

    // A typo still declares the room but is reported on join.
    declareRoom(path.join(repo, "packages", "web"), 'nmae = "web"\n');
    const typo = service.joinPath({ agent_id: "grok:typo", context_path: path.join(repo, "packages", "web") });
    expect(typo.canonical_path).toBe(realPath(path.join(repo, "packages", "web")));
    expect(typo.warning).toMatch(/room\.toml:1 is not understood: nmae/);
  });

  test("worktrees converge on one declared room and branches without it use the root", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-mono-wt-"));
    tempRoots.push(tempRoot);
    const repo = createRepo(tempRoot);
    commitAll(repo);
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "plain", path.join(tempRoot, "plain")]);
    declareRoom(path.join(repo, "packages", "api"));
    commitAll(repo);
    const declared = path.join(tempRoot, "declared");
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "declared", declared]);
    const service = new TalkingStickService({ dbPath: path.join(tempRoot, "state", "rooms.sqlite") });
    services.push(service);

    const mainApi = service.joinPath({ agent_id: "claude:main", context_path: path.join(repo, "packages", "api") });
    const linkedApi = service.joinPath({ agent_id: "codex:linked", context_path: path.join(declared, "packages", "api", "src") });
    expect(linkedApi.room_id).toBe(mainApi.room_id);
    expect(linkedApi.canonical_path).toBe(path.join(realPath(repo), "packages", "api"));

    // A legacy room created exactly at the worktree's declaration directory
    // keeps its id and lease on the next ordinary join.
    const wtApi = path.join(declared, "packages", "api");
    const legacy = service.joinPath({ agent_id: "claude:wt-legacy", context_path: wtApi, force_new: true });
    expect(legacy.room_id).not.toBe(mainApi.room_id);
    const grant = await service.waitForTurn({ agent_id: "claude:wt-legacy", room_id: legacy.room_id, max_wait_ms: 0, allow_solo_claim: true });
    expect(grant.status).toBe("your_turn");
    const rejoin = service.joinPath({ agent_id: "claude:wt-legacy", context_path: path.join(wtApi, "src") });
    expect(rejoin.room_id).toBe(legacy.room_id);
    expect(rejoin.room_state.owner).toBe("claude:wt-legacy");

    const plainApi = service.joinPath({ agent_id: "grok:plain", context_path: path.join(tempRoot, "plain", "packages", "api") });
    expect(plainApi.room_id).not.toBe(mainApi.room_id);
    expect(plainApi.canonical_path).toBe(realPath(repo));
  });

  test("retiring a declared room refuses agents but not chat observers", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-retire-"));
    tempRoots.push(tempRoot);
    const repo = createRepo(tempRoot);
    const api = path.join(repo, "packages", "api");
    declareRoom(api);
    const service = new TalkingStickService({ dbPath: path.join(tempRoot, "state", "rooms.sqlite") });
    services.push(service);
    const opened = service.openRoom({ context_path: api });
    expect(opened.canonical_path).toBe(realPath(api));
    expect(service.joinPath({ agent_id: "codex:api", context_path: api }).room_id).toBe(opened.room_id);
    expect(() => service.retireUnoccupiedRoom({ room_id: opened.room_id })).toThrow(/still has members/);
    service.leaveRoom({ agent_id: "codex:api", room_id: opened.room_id });

    const again = service.openRoom({ context_path: api });
    service.joinPath({ agent_id: "human:op:chat:1", context_path: api,
      process_metadata: { session_kind: "human_chat" } });
    expect(service.retireUnoccupiedRoom({ room_id: again.room_id })).toEqual({ retired: true });
    expect(service.listRooms({}).rooms.some((room) => room.room_id === again.room_id)).toBe(false);
  });

  test("an existing nested legacy room keeps winning inside a declared room", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-mono-legacy-"));
    tempRoots.push(tempRoot);
    const repo = createRepo(tempRoot);
    const src = path.join(repo, "packages", "api", "src");
    const service = new TalkingStickService({ dbPath: path.join(tempRoot, "state", "rooms.sqlite") });
    services.push(service);
    const legacy = service.joinPath({ agent_id: "claude:legacy", context_path: src, force_new: true });
    declareRoom(path.join(repo, "packages", "api"));
    expect(service.joinPath({ agent_id: "codex:legacy", context_path: src }).room_id).toBe(legacy.room_id);
    expect(service.joinPath({ agent_id: "codex:api", context_path: path.join(repo, "packages", "api") }).room_id)
      .not.toBe(legacy.room_id);
  });

  test("git worktrees share the main repository room unless explicitly isolated", () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "talking-stick-worktree-")
    );
    tempRoots.push(tempRoot);
    const main = path.join(tempRoot, "umbrella", "main");
    const linked = path.join(tempRoot, "linked");
    fs.mkdirSync(main, { recursive: true });
    execFileSync("git", ["init", "-b", "main", main]);
    execFileSync("git", ["-C", main, "config", "user.name", "Test User"]);
    execFileSync("git", ["-C", main, "config", "user.email", "test@example.com"]);
    fs.writeFileSync(path.join(main, "package.json"), "{}\n");
    execFileSync("git", ["-C", main, "add", "package.json"]);
    execFileSync("git", ["-C", main, "commit", "-m", "Initial commit"]);
    execFileSync("git", [
      "-C",
      main,
      "worktree",
      "add",
      "-b",
      "linked",
      linked
    ]);

    expect(resolveContextPath(main).workspace_root).toBe(realPath(main));
    expect(resolveContextPath(linked).workspace_root).toBe(realPath(main));

    const service = new TalkingStickService({
      dbPath: path.join(tempRoot, "state", "rooms.sqlite")
    });
    services.push(service);
    const mainJoin = service.joinPath({
      agent_id: "claude:main",
      context_path: main
    });
    const linkedJoin = service.joinPath({
      agent_id: "codex:linked",
      context_path: linked
    });

    expect(linkedJoin.room_id).toBe(mainJoin.room_id);
    expect(linkedJoin.canonical_path).toBe(realPath(main));
    expect(service.listRooms({ context_path: linked }).rooms).toHaveLength(1);

    // A repository is its own root: a room above the main checkout no longer
    // absorbs the repository or its linked worktrees.
    const umbrella = service.joinPath({ agent_id: "human:umbrella", context_path: path.dirname(main), force_new: true });
    service.leaveRoom({ agent_id: "claude:main", room_id: mainJoin.room_id });
    service.leaveRoom({ agent_id: "codex:linked", room_id: mainJoin.room_id });
    expect(umbrella.room_id).not.toBe(mainJoin.room_id);
    // The emptied repository room may have been retired; either way the
    // worktree and main checkout land in the repository's room, not the umbrella.
    const fromLinked = service.joinPath({ agent_id: "codex:umbrella", context_path: linked });
    expect(fromLinked.room_id).not.toBe(umbrella.room_id);
    expect(fromLinked.canonical_path).toBe(realPath(main));
    expect(service.joinPath({ agent_id: "claude:umbrella", context_path: main }).room_id).toBe(fromLinked.room_id);

    const isolated = service.joinPath({
      agent_id: "grok:isolated",
      context_path: linked,
      force_new: true
    });
    expect(isolated.room_id).not.toBe(mainJoin.room_id);
    expect(isolated.canonical_path).toBe(realPath(linked));

    const nestedLinked = path.join(linked, "src");
    fs.mkdirSync(nestedLinked);
    expect(
      service.joinPath({
        agent_id: "codex:nested-linked",
        context_path: nestedLinked
      }).room_id
    ).toBe(isolated.room_id);
  });
});

function createRepo(tempRoot: string, name = "repo"): string {
  const repo = path.join(tempRoot, name);
  fs.mkdirSync(path.join(repo, "packages", "api", "src"), { recursive: true });
  fs.mkdirSync(path.join(repo, "packages", "web"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test User"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(repo, "package.json"), "{}\n");
  fs.writeFileSync(path.join(repo, "packages", "web", "package.json"), "{}\n");
  fs.writeFileSync(path.join(repo, "packages", "api", "src", "index.ts"), "\n");
  return repo;
}

function declareRoom(directory: string, body = 'name = "api"\n'): void {
  fs.mkdirSync(path.join(directory, ".talking-stick"), { recursive: true });
  fs.writeFileSync(path.join(directory, ".talking-stick", "room.toml"), body);
}

function commitAll(repo: string): void {
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "snapshot"]);
}

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
