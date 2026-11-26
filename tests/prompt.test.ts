import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { sanitizeIdentityComponent } from "../src/identity-name.js";
import { resolveContextPath, resolveGitRootsFromFilesystem } from "../src/path-resolution.js";
import { formatPrompt } from "../src/prompt/format.js";
import { promptInitScript } from "../src/prompt/init.js";
import { runPromptCommand } from "../src/prompt/main.js";
import { readPromptState, type PromptState } from "../src/prompt/state.js";
import { openSqlite } from "../src/sqlite.js";
import { TalkingStickService } from "../src/service.js";

const roots: string[] = [];
const services: TalkingStickService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tt-prompt-")));
  roots.push(root);
  return root;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", "-c", "protocol.file.allow=always", ...args],
    { cwd, stdio: "ignore" });
}

const human = `human:${sanitizeIdentityComponent(os.userInfo().username)}`;

describe("filesystem Git roots", () => {
  test("match git for a checkout, a nested folder, a linked worktree, a submodule, a declared room and no repository", () => {
    const root = tempRoot();
    const main = path.join(root, "main");
    fs.mkdirSync(path.join(main, "pkg", "deep"), { recursive: true });
    git(root, "init", "-q", "main");
    fs.writeFileSync(path.join(main, "README.md"), "x\n");
    fs.mkdirSync(path.join(main, "pkg", ".talking-stick"));
    fs.writeFileSync(path.join(main, "pkg", ".talking-stick", "room.toml"), 'name = "pkg"\n');
    git(main, "add", ".");
    git(main, "commit", "-qm", "init");
    git(main, "worktree", "add", "-q", path.join(root, "linked"));
    const sub = path.join(root, "sub");
    git(root, "init", "-q", "sub");
    fs.writeFileSync(path.join(sub, "a"), "a\n");
    git(sub, "add", ".");
    git(sub, "commit", "-qm", "sub");
    git(main, "submodule", "add", "-q", sub, "vendor/sub");
    const plain = path.join(root, "plain", "inner");
    fs.mkdirSync(plain, { recursive: true });

    for (const dir of [main, path.join(main, "pkg", "deep"), path.join(root, "linked"), path.join(root, "linked", "pkg"),
      path.join(main, "vendor", "sub"), plain]) {
      expect(resolveContextPath(dir, { gitRoots: resolveGitRootsFromFilesystem })).toEqual(resolveContextPath(dir));
    }
  });
});

describe("rooms prompt", () => {
  function room() {
    const dataDir = tempRoot();
    const project = path.join(dataDir, "ceramics");
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "package.json"), "{}\n");
    const service = new TalkingStickService({ dataDir });
    services.push(service);
    const console = `${human}:chat:aaaaaaaa`;
    const joined = service.joinPath({ agent_id: console, context_path: project, process_metadata: { session_kind: "human_chat" } });
    service.joinPath({ agent_id: "claude:aa", context_path: project, process_metadata: { display_name: "claude" } });
    service.joinPath({ agent_id: "codex:bb", context_path: project });
    return { service, dataDir, project, roomId: joined.room_id, console };
  }
  const read = (dataDir: string, cwd: string, extra: NodeJS.ProcessEnv = {}) =>
    readPromptState({ cwd, env: { TALKING_STICK_DATA_DIR: dataDir, ...extra } });

  test("shows the room, its agents, the holder, open blockers and unread messages for this human", () => {
    const { service, dataDir, project, roomId, console } = room();
    expect(formatPrompt(read(dataDir, project)!)).toBe("#ceramics 2");

    service.addBlocker({ room_id: roomId, agent_id: "claude:aa", body: "May I merge?" });
    const direct = service.sendMessage({ agent_id: "claude:aa", room_id: roomId, to_agent_id: console, body: "look" });
    service.sendMessage({ agent_id: "claude:aa", room_id: roomId, body: "broadcast" });
    const db = openSqlite(path.join(dataDir, "rooms.sqlite"));
    db.prepare("UPDATE path_rooms SET owner = ?, lease_expires_at = ? WHERE room_id = ?")
      .run("claude:aa", new Date(Date.now() + 60_000).toISOString(), roomId);
    db.close();

    const state = read(dataDir, path.join(project, "sub-folder-that-does-not-exist"))!;
    expect(state).toMatchObject({ room: "ceramics", members: 2, names: ["claude", "codex"], holder: "claude", blockers: 1, unread: 1 });
    expect(formatPrompt(state)).toBe("#ceramics 2 ▸claude !1 @1");
    expect(formatPrompt(state, "{room}: {names}")).toBe("ceramics: claude codex");

    service.acknowledgeHumanMessage({ room_id: roomId, agent_id: console, event_seq: direct.event_seq });
    expect(read(dataDir, project)!.unread).toBe(0);
  });

  test("drops an expired holder and a member whose same-host process is gone", () => {
    const { service, dataDir, project, roomId } = room();
    service.joinPath({ agent_id: "grok:cc", context_path: project,
      process_metadata: { host_id: os.hostname(), pid: 999_999_999, process_started_at: "t", session_kind: "harness_cli" } });
    const db = openSqlite(path.join(dataDir, "rooms.sqlite"));
    db.prepare("UPDATE path_rooms SET owner = ?, lease_expires_at = ? WHERE room_id = ?").run("codex:bb", new Date(0).toISOString(), roomId);
    db.close();
    const state = readPromptState({ cwd: project, env: { TALKING_STICK_DATA_DIR: dataDir },
      processAlive: (pid) => pid !== 999_999_999 })!;
    expect(state).toMatchObject({ members: 2, holder: null });
  });

  test("counts an inactive standby member with a live local process", () => {
    const { service, dataDir, project, roomId } = room();
    service.joinPath({ agent_id: "grok:cc", context_path: project,
      process_metadata: { host_id: os.hostname(), pid: process.pid, process_started_at: "t", session_kind: "harness_cli" } });
    const db = openSqlite(path.join(dataDir, "rooms.sqlite"));
    db.prepare("UPDATE room_members SET status = 'inactive', wait_intent = 'parked' WHERE room_id = ? AND agent_id = ?")
      .run(roomId, "grok:cc");
    db.close();
    expect(read(dataDir, project)).toMatchObject({ members: 3, names: ["claude", "codex", "grok"] });
  });

  test("prints nothing outside a room, without a database, or for a broken one", () => {
    const { dataDir } = room();
    const outside = tempRoot();
    expect(read(dataDir, outside)).toBeNull();
    expect(read(path.join(outside, "missing"), outside)).toBeNull();
    const broken = tempRoot();
    fs.writeFileSync(path.join(broken, "rooms.sqlite"), "not a database");
    expect(read(broken, outside)).toBeNull();
  });

  test("follows TT_ROOM by id or path", () => {
    const { dataDir, project, roomId } = room();
    const elsewhere = tempRoot();
    expect(read(dataDir, elsewhere, { TT_ROOM: roomId })?.room).toBe("ceramics");
    expect(read(dataDir, elsewhere, { TT_ROOM: fs.realpathSync(project) })?.room).toBe("ceramics");
    const link = path.join(elsewhere, "room-link");
    fs.symlinkSync(project, link, "junction");
    expect(read(dataDir, elsewhere, { TT_ROOM: `${link}/` })?.room).toBe("ceramics");
  });

  test("shows nothing for a stale pin, even inside an open room", () => {
    const { dataDir, project } = room();
    const elsewhere = tempRoot();
    expect(read(dataDir, project)?.room).toBe("ceramics");
    expect(read(dataDir, project, { TT_ROOM: "missing-room-id" })).toBeNull();
    expect(read(dataDir, project, { TT_ROOM: path.join(elsewhere, "missing-room-path") })).toBeNull();
  });

  test("never writes to the database", () => {
    const { dataDir, project } = room();
    const file = path.join(dataDir, "rooms.sqlite");
    const before = fs.statSync(file).mtimeMs;
    const events = () => { const db = openSqlite(file, { readonly: true }); try {
      return (db.prepare("SELECT COUNT(*) AS n FROM room_events").get() as { n: number }).n; } finally { db.close(); } };
    const count = events();
    read(dataDir, project);
    expect(events()).toBe(count);
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });
});

describe("prompt output", () => {
  const state: PromptState = { room_id: "r", room: "api", room_path: "/x/api", members: 3, names: ["a", "b", "c"],
    holder: null, blockers: 0, unread: 2 };

  test("conditional fields appear only when set", () => {
    expect(formatPrompt(state)).toBe("#api 3 @2");
    expect(formatPrompt(state, "[{room}{holder: by }]")).toBe("[api]");
    expect(formatPrompt(state, "{unknown}")).toBe("{unknown}");
  });

  test("init prints glue for each shell and rejects others", () => {
    const out: string[] = [];
    const err: string[] = [];
    for (const shell of ["zsh", "bash", "fish"]) {
      expect(runPromptCommand(["init", shell], (text) => out.push(text), (text) => err.push(text))).toBe(0);
    }
    expect(out[0]).toContain("add-zsh-hook precmd _rooms_prompt_precmd");
    expect(out[1]).toContain("PROMPT_COMMAND=");
    expect(out[2]).toContain("function rooms_prompt");
    expect(runPromptCommand(["init", "tcsh"], () => {}, (text) => err.push(text))).toBe(1);
    expect(err.join("")).toMatch(/Usage: rooms prompt init/);
  });

  test("fish reserves private storage and publishes each refresh atomically", () => {
    const script = promptInitScript("fish", "rooms prompt");
    expect(script).toContain('for base in "$XDG_RUNTIME_DIR" "$TMPDIR" /tmp');
    expect(script).toContain('mktemp -d "$base/rooms-prompt.XXXXXXXXXX"');
    expect(script).toContain('tmp="$2.$$.tmp"');
    expect(script).toContain('mv "$tmp" "$2" && kill -USR1 "$3"');
    expect(script).toContain('rm -rf -- "$__rooms_prompt_dir"');
  });

  test("fish quoting survives a path with quotes and spaces", () => {
    const script = promptInitScript("fish", "node '/a b/it'\\''s/entry.js'");
    expect(script).toContain(String.raw`'node \'/a b/it\'\\\'\'s/entry.js\''`);
  });
});
