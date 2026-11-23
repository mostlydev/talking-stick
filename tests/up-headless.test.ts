import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { parseCommand } from "../src/cli/parser.js";
import type { Runtime } from "../src/cli/runtime.js";
import { handleUpCommand } from "../src/cli/up.js";
import { headlessPrefix, workerSearchPath, type HeadlessUpOptions } from "../src/cli/up-headless.js";
import { installLaunchAgent, launchAgentPath } from "../src/supervisor/launchd.js";
import { prepareSupervisorRoot } from "../src/supervisor/root.js";
import { supervisorPaths } from "../src/supervisor/run.js";
import { SupervisorStore } from "../src/supervisor/state.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
  process.exitCode = undefined;
});

function setup(options: { installed?: string[]; ttOnPath?: boolean } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tt-headless-")));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const repo = path.join(root, "shrooms");
  const other = path.join(root, "elsewhere");
  const bin = path.join(root, "bin");
  const dataDir = path.join(root, "data");
  for (const dir of [home, repo, other, bin]) fs.mkdirSync(dir, { recursive: true });
  const executables = [...(options.ttOnPath === false ? [] : ["tt"]), ...(options.installed ?? ["claude", "codex", "grok", "agy"])];
  for (const name of executables) fs.writeFileSync(path.join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
  for (const dir of [[".claude", "skills"], [".agents", "skills"], [".gemini", "config", "skills"]]) {
    const skill = path.join(home, ...dir, "rooms");
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, "SKILL.md"), "# skill\n");
  }
  const env: NodeJS.ProcessEnv = { PATH: bin, TALKING_STICK_DATA_DIR: dataDir,
    TT_SUPERVISOR_STATE_DIR: process.env.TT_SUPERVISOR_STATE_DIR };
  const runtime = { commands: {
    listRooms: () => ({ rooms: [{ canonical_path: repo, room_id: "room-1", state: "idle" }] })
  } } as unknown as Runtime;

  const launchctl: string[][] = [];
  let loaded = false;
  const installs: Array<{ searchPath?: string; replace: false }> = [];
  const headless: HeadlessUpOptions = {
    platform: "darwin",
    launchctl: (args) => {
      launchctl.push(args);
      if (args[0] === "print" && !loaded) throw new Error("not loaded");
    },
    liveness: () => "gone",
    installService: (installDataDir, installRoot, installOptions) => {
      installs.push(installOptions);
      const plist = launchAgentPath(home);
      fs.mkdirSync(path.dirname(plist), { recursive: true });
      fs.writeFileSync(plist, `<key>TALKING_STICK_DATA_DIR</key>\n    <string>${installDataDir}</string>\n` +
        `<key>TT_SUPERVISOR_STATE_DIR</key>\n    <string>${path.dirname(installRoot.dir)}</string>\n`);
      loaded = true;
      return plist;
    }
  };

  const up = async (args: string[], overrides: Partial<HeadlessUpOptions> = {}) => {
    const output: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true; });
    try {
      await handleUpCommand(runtime, parseCommand(["up", "--headless", "--path", repo, "--json", ...args]),
        { env, homeDir: home, headless: { ...headless, ...overrides } });
    } finally { stdout.mockRestore(); }
    return JSON.parse(output.join(""));
  };
  const store = () => {
    const opened = new SupervisorStore(supervisorPaths(prepareSupervisorRoot(dataDir, env).dir).database);
    cleanup.push(() => opened.close());
    return opened;
  };
  const spec = (worker: string) => {
    const row = store().worker(worker);
    return row ? JSON.parse(row.spec_json) : null;
  };
  return { root, home, repo, other, bin, dataDir, env, up, store, spec, launchctl, installs,
    setLoaded: (value: boolean) => { loaded = value; } };
}

describe("tt up --headless", () => {
  test("adds an auto-approving worker per agent, named after the room, and installs the supervisor", async () => {
    const t = setup();
    const result = await t.up(["--agents", "claude,codex,grok,agy"]);
    expect(result).toMatchObject({ status: "started", room: "shrooms", canonical_path: t.repo, new_workers: "unrestricted",
      service: { state: "installed", plist: launchAgentPath(t.home) } });
    expect(result.workers.map((worker: { worker: string; action: string; unrestricted: boolean }) =>
      [worker.worker, worker.action, worker.unrestricted])).toEqual([
      ["shrooms-claude", "added", true], ["shrooms-codex", "added", true],
      ["shrooms-grok", "added", true], ["shrooms-agy", "added", true]]);
    expect(t.spec("shrooms-claude")).toMatchObject({ harness: "claude", cwd: t.repo,
      permissions: { harness: "claude", mode: "bypassPermissions" }, env: [{ name: "PATH", from: "literal", value: t.bin }] });
    expect(t.spec("shrooms-codex").permissions).toEqual({ harness: "codex", sandbox: "danger-full-access", approval: "never" });
    expect(t.spec("shrooms-grok").permissions).toEqual({ harness: "grok", mode: "bypassPermissions" });
    expect(t.spec("shrooms-agy")).toMatchObject({ harness: "antigravity", permissions: { harness: "antigravity", mode: "bypassPermissions" } });
    expect(t.installs).toEqual([{ searchPath: t.bin, replace: false }]);
    expect(result.next_steps).toContain(`Watch and direct the room: tt chat ${t.repo}`);
    expect(result.next_steps).toContain(`From another session: tt room brief ${t.repo}`);
  });

  test("a second run leaves the same-folder workers alone and never restarts a loaded user agent", async () => {
    const t = setup();
    await t.up(["--agents", "claude,codex"]);
    const again = await t.up(["--agents", "claude,codex"]);
    expect(again.status).toBe("nothing_to_add");
    expect(again.workers.map((worker: { action: string }) => worker.action)).toEqual(["exists", "exists"]);
    // Installed a moment ago and loaded, but its owner lock isn't written yet.
    expect(again.service).toEqual({ state: "starting", plist: launchAgentPath(t.home) });
    expect(t.installs).toHaveLength(1);
  });

  test("an existing worker for the folder is reused under any name and keeps its own permissions", async () => {
    const t = setup();
    t.store().addWorker({ worker_id: "mine", harness: "codex", cwd: t.repo, env: [],
      permissions: { harness: "codex", sandbox: "workspace-write", approval: "on-request" } }, "human:test", new Date().toISOString());
    const result = await t.up(["--agents", "codex"]);
    expect(result.workers).toEqual([{ agent: "codex", worker: "mine", action: "exists", unrestricted: false,
      desired: "running", hold_reason: null }]);
    expect(t.spec("shrooms-codex")).toBeNull();
  });

  test("a name taken by a worker in another folder is refused, adds nothing, and --prefix picks another", async () => {
    const t = setup();
    t.store().addWorker({ worker_id: "shrooms-claude", harness: "claude", cwd: t.other, env: [],
      permissions: { harness: "claude", mode: "default" } }, "human:test", new Date().toISOString());
    await expect(t.up(["--agents", "claude,codex"])).rejects.toThrow(
      new RegExp(`shrooms-claude already runs claude in ${t.other}.*Nothing was added.*--prefix shrooms-2`));
    expect(t.spec("shrooms-codex")).toBeNull();
    expect(t.installs).toHaveLength(0);

    const result = await t.up(["--agents", "claude,codex", "--prefix", "shrooms-2"]);
    expect(result.workers.map((worker: { worker: string }) => worker.worker)).toEqual(["shrooms-2-claude", "shrooms-2-codex"]);
    expect(t.spec("shrooms-claude").cwd).toBe(t.other);
  });

  test("--restricted adds workers under each harness's own rules", async () => {
    const t = setup();
    const result = await t.up(["--agents", "claude,codex,grok,agy", "--restricted"]);
    expect(result.new_workers).toBe("restricted");
    expect(result.workers.every((worker: { unrestricted: boolean }) => !worker.unrestricted)).toBe(true);
    expect(t.spec("shrooms-claude").permissions).toEqual({ harness: "claude", mode: "default" });
    expect(t.spec("shrooms-codex").permissions).toEqual({ harness: "codex", sandbox: "workspace-write", approval: "on-request" });
    expect(t.spec("shrooms-grok").permissions).toEqual({ harness: "grok", mode: "default" });
    expect(t.spec("shrooms-agy").permissions).toEqual({ harness: "antigravity", mode: "default" });
  });

  test("--print previews the workers and the service and changes nothing", async () => {
    const t = setup();
    const result = await t.up(["--agents", "claude", "--print"]);
    expect(result).toMatchObject({ status: "preview", workers: [{ worker: "shrooms-claude", action: "add", unrestricted: true }],
      service: { state: "would_install" } });
    expect(t.installs).toHaveLength(0);
    expect(fs.existsSync(launchAgentPath(t.home))).toBe(false);
    expect(t.spec("shrooms-claude")).toBeNull();
  });

  test("without --agents it starts the installed default pair", async () => {
    const t = setup({ installed: ["codex", "grok"] });
    const result = await t.up([]);
    expect(result.workers.map((worker: { agent: string }) => worker.agent)).toEqual(["codex"]);
  });

  test("a live supervisor is left alone", async () => {
    const t = setup();
    const root = prepareSupervisorRoot(t.dataDir, t.env);
    fs.writeFileSync(supervisorPaths(root.dir).lock, JSON.stringify({ pid: process.pid, process_started_at: "now" }));
    const result = await t.up(["--agents", "claude"], { liveness: () => "alive" });
    expect(result.service).toEqual({ state: "running" });
    expect(t.installs).toHaveLength(0);
  });

  test("a user agent serving another data directory is not repointed", async () => {
    const t = setup();
    const plist = launchAgentPath(t.home);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, "<key>TALKING_STICK_DATA_DIR</key>\n    <string>/somewhere/else</string>\n");
    const result = await t.up(["--agents", "claude"]);
    expect(result.service).toMatchObject({ state: "not_started", detail: expect.stringContaining("/somewhere/else") });
    expect(t.installs).toHaveLength(0);
    expect(t.spec("shrooms-claude")).not.toBeNull();
    expect(process.exitCode).toBe(1);
  });

  test("a user agent that can't be identified is reported as unknown and never booted out", async () => {
    const t = setup();
    // Loaded under the label, but with no plist to say which profile it serves.
    t.setLoaded(true);
    const loadedWithoutPlist = await t.up(["--agents", "claude"]);
    expect(loadedWithoutPlist.service).toMatchObject({ state: "unknown", remedy: expect.stringContaining("tt supervisor status") });
    // A plist that names no data directory.
    t.setLoaded(false);
    const plist = launchAgentPath(t.home);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, "<plist/>\n");
    const unreadable = await t.up(["--agents", "codex"]);
    expect(unreadable.service.state).toBe("unknown");
    // This data directory, but from before the state folder was recorded.
    fs.writeFileSync(plist, `<key>TALKING_STICK_DATA_DIR</key>\n    <string>${t.dataDir}</string>\n`);
    expect((await t.up(["--agents", "grok"])).service.state).toBe("unknown");
    // This data directory with its workers registered in another state folder.
    fs.writeFileSync(plist, `<key>TALKING_STICK_DATA_DIR</key>\n    <string>${t.dataDir}</string>\n` +
      "<key>TT_SUPERVISOR_STATE_DIR</key>\n    <string>/other/state</string>\n");
    expect((await t.up(["--agents", "agy"])).service).toMatchObject({ state: "not_started",
      detail: expect.stringContaining("/other/state") });
    expect(t.installs).toHaveLength(0);
    expect(t.launchctl.every((args) => args[0] === "print")).toBe(true);
  });

  test("a bootstrap that fails because an agent loaded meanwhile reports it starting", async () => {
    const t = setup();
    const result = await t.up(["--agents", "claude"], { installService: () => {
      t.setLoaded(true);
      throw new Error("Bootstrap failed: 5: Input/output error");
    } });
    expect(result.service).toEqual({ state: "starting", plist: launchAgentPath(t.home) });
    expect(process.exitCode).toBeUndefined();
  });

  test("the automatic install never boots out a loaded agent; an explicit one replaces it", () => {
    const t = setup();
    const calls: string[][] = [];
    const install = (replace?: boolean) => installLaunchAgent({ program: [process.execPath, "supervisor", "run"],
      dataDir: t.dataDir, logPath: path.join(t.root, "logs", "launchd.log"), homeDir: t.home,
      launchctl: (args) => { calls.push(args); }, ...(replace === undefined ? {} : { replace }) });
    install(false);
    expect(calls.map((args) => args[0])).toEqual(["bootstrap"]);
    calls.length = 0;
    install();
    expect(calls.map((args) => args[0])).toEqual(["bootout", "bootstrap"]);
  });

  test("a failed install keeps the workers and names the remedy", async () => {
    const t = setup();
    const result = await t.up(["--agents", "claude"], { installService: () => { throw new Error("launchctl: Operation not permitted"); } });
    expect(result.service).toMatchObject({ state: "not_started", detail: expect.stringContaining("Operation not permitted"),
      remedy: expect.stringContaining("tt supervisor install") });
    expect(result.next_steps[0]).toContain("tt supervisor install");
    expect(t.spec("shrooms-claude")).not.toBeNull();
    expect(process.exitCode).toBe(1);
  });

  test("Linux prints how to run the supervisor instead of installing one", async () => {
    const t = setup();
    const result = await t.up(["--agents", "claude"], { platform: "linux" });
    expect(result.service).toMatchObject({ state: "not_started", remedy: expect.stringContaining("tt supervisor run") });
    expect(t.installs).toHaveLength(0);
  });

  test("refuses pane-only flags, OpenCode, Windows, a missing folder and an agent that is not installed", async () => {
    const t = setup({ installed: ["claude", "codex"] });
    await expect(t.up(["--new-tab"])).rejects.toThrow("--new-tab is for panes");
    await expect(t.up(["--agents", "opencode"])).rejects.toThrow("OpenCode has no headless worker");
    await expect(t.up([], { platform: "win32" })).rejects.toThrow("macOS and Linux");
    await expect(t.up(["--agents", "grok"])).rejects.toThrow("Cannot start grok (not installed) here.");
    await expect(t.up(["--prefix", "Bad Name"])).rejects.toThrow("--prefix is lowercase");
    for (const flag of ["--agents", "--prefix"]) await expect(t.up([flag])).rejects.toThrow(`${flag} needs a value.`);
    await expect(handleUpCommand({} as Runtime, parseCommand(["up", "--headless", "--path", "--json"]),
      { env: t.env, homeDir: t.home })).rejects.toThrow("--path needs a value.");
    await expect(handleUpCommand({} as Runtime, parseCommand(["up", "--headless", "--path", path.join(t.root, "missing")]),
      { env: t.env, homeDir: t.home })).rejects.toThrow("is not a directory");
    expect(t.installs).toHaveLength(0);
  });

  test("plain tt up refuses the headless-only flags", async () => {
    const t = setup();
    await expect(handleUpCommand({} as Runtime, parseCommand(["up", "--restricted"]), { env: t.env, homeDir: t.home }))
      .rejects.toThrow("add --headless");
  });

  test("workers get tt's folder on PATH when the caller's PATH lacks it", async () => {
    const t = setup({ ttOnPath: false });
    const local = path.join(t.home, ".local", "bin");
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, "tt"), "#!/bin/sh\n", { mode: 0o755 });
    expect(workerSearchPath(t.env, t.home, "darwin")).toBe(`${local}:${t.bin}`);
    await t.up(["--agents", "claude"]);
    expect(t.spec("shrooms-claude").env).toEqual([{ name: "PATH", from: "literal", value: `${local}:${t.bin}` }]);
    expect(t.installs[0]).toEqual({ searchPath: `${local}:${t.bin}`, replace: false });
    // A PATH that already finds tt is kept as it is.
    expect(workerSearchPath({ PATH: `${t.bin}:${local}` }, t.home, "darwin")).toBe(`${t.bin}:${local}`);
  });

  test("worker-name prefixes are lowercase and worker-id safe", () => {
    expect(headlessPrefix("Talking Stick")).toBe("talking-stick");
    expect(headlessPrefix("__api")).toBe("api");
    expect(headlessPrefix("!!!")).toBe("room");
    expect(headlessPrefix("a".repeat(60))).toHaveLength(40);
  });
});
