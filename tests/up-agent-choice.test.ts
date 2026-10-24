import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AgentPicker, pickerFits, renderAgentPicker } from "../src/cli/agent-picker.js";
import { parseCommand } from "../src/cli/parser.js";
import type { Runtime } from "../src/cli/runtime.js";
import { handleUpCommand, type AgentPickerPrompt } from "../src/cli/up.js";
import {
  launchDefaultsPath,
  readLaunchDefaults,
  resolveAgentChoice,
  saveAgentChoice
} from "../src/launch-defaults.js";
import type { LaunchAgent } from "../src/workspace-launch.js";
import { FakeHerdr } from "./fixtures/fake-herdr.js";

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  process.exitCode = undefined;
});

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempRoots.push(dir);
  return dir;
}

const rows = (unavailable: Partial<Record<LaunchAgent, string>> = {}) =>
  (["claude", "codex", "grok", "opencode", "antigravity"] as const).map((agent) => ({ agent, unavailable: unavailable[agent] }));

describe("agent picker", () => {
  test("moves over launchable rows, toggles, picks a scope and refuses an empty start", () => {
    const picker = new AgentPicker(rows({ opencode: "not installed" }), ["claude", "codex"]);
    expect(picker.rows.map((row) => row.agent)).toEqual(["claude", "codex", "grok", "antigravity", "opencode"]);
    picker.key("down");
    picker.key("down");
    picker.key("toggle");
    picker.key("down");
    picker.key("down");
    // The unavailable row is never reached.
    expect(picker.rows[picker.cursor].agent).toBe("antigravity");
    picker.key("right");
    expect(picker.key("enter")).toEqual({ kind: "done", agents: ["claude", "codex", "grok"], scope: "room" });

    const empty = new AgentPicker(rows(), []);
    expect(empty.key("enter")).toEqual({ kind: "pending" });
    expect(empty.key("cancel")).toEqual({ kind: "cancel" });
  });

  test("a saved but unavailable agent is never preselected", () => {
    const picker = new AgentPicker(rows({ grok: "saved but not installed" }), ["grok", "claude"]);
    expect([...picker.checked]).toEqual(["claude"]);
  });

  test("renders every agent, dims unavailable ones and keeps a blank row before the hints", () => {
    const lines = renderAgentPicker(new AgentPicker(rows({ opencode: "not installed" }), ["claude", "codex"]), "talking-stick", false);
    expect(lines[0]).toBe("Start which agents in talking-stick?");
    expect(lines).toContain("  ❯ [x] Claude Code");
    expect(lines).toContain("    [ ] Grok         experimental");
    expect(lines).toContain("    -   OpenCode     not installed");
    expect(lines.at(-3)).toContain("‹ every room ›");
    expect(lines.at(-2)).toBe("");
    expect(lines.at(-1)).toContain("Enter start");
  });
});

test("fits a narrow, short terminal and never prints control characters from the room name", () => {
  const picker = new AgentPicker(rows({ opencode: "skill missing · tt install opencode" }), ["claude"]);
  const plain = (line: string) => line.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  const narrow = renderAgentPicker(picker, "evil\u001b[2Jroom\u0007", true, "256", { columns: 20, rows: 24 });
  expect(narrow.every((line) => plain(line).length <= 19)).toBe(true);
  const wide = renderAgentPicker(picker, "evil\u001b[2Jroom\u0007", true, "256", { columns: 80, rows: 24 });
  expect(wide[0]).not.toContain("\u001b[2J");
  expect(plain(wide[0])).toContain("evil?[2Jroom?");
  const short = renderAgentPicker(picker, "room", false, "256", { columns: 80, rows: 7 });
  expect(short).toHaveLength(7);
  expect(short).not.toContain("");
  expect(short[0]).toContain("Start which agents");
  // Too small to show every row and the remember line whole: a notice, never a hidden choice.
  expect(pickerFits(picker, { columns: 80, rows: 5 })).toBe(false);
  expect(pickerFits(picker, { columns: 40, rows: 24 })).toBe(false);
  expect(pickerFits(picker, { columns: 50, rows: 6 })).toBe(true);
  expect(renderAgentPicker(picker, "room", false, "256", { columns: 40, rows: 24 }))
    .toEqual(["Terminal too small to choose agents.", "Enlarge it, or press Esc to cancel."]);
});

test("the end of input cancels and restores the terminal", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode(raw: boolean) { input.isRaw = raw; return input; } });
  const written: string[] = [];
  const output = Object.assign(new EventEmitter(), { columns: 40, rows: 20, write: (chunk: string) => { written.push(chunk); return true; } });
  const { runAgentPicker } = await import("../src/cli/agent-picker.js");
  const pending = runAgentPicker(new AgentPicker(rows(), ["claude"]), "room",
    { input: input as unknown as NodeJS.ReadStream, output: output as unknown as NodeJS.WriteStream, env: {} });
  output.emit("resize");
  // Too narrow: Enter is ignored until the terminal fits.
  output.columns = 30;
  output.emit("resize");
  input.write("\r");
  await new Promise((resolve) => setImmediate(resolve));
  input.end();
  await expect(pending).resolves.toBeNull();
  expect(input.isRaw).toBe(false);
  expect(input.listenerCount("keypress")).toBe(0);
  expect(output.listenerCount("resize")).toBe(0);
  expect(written.join("")).toMatch(/\u001b\[\?1049h[\s\S]*\u001b\[\?25h\u001b\[\?1049l$/);
});

describe("saved agent choice", () => {
  test("--agents, then the room override, then the default, then the installed pair", () => {
    const launchable: LaunchAgent[] = ["claude", "codex", "grok"];
    const defaults = { agents: ["claude"] as LaunchAgent[], rooms: { "/repo/api": ["grok", "codex"] as LaunchAgent[] } };
    expect(resolveAgentChoice({ requested: ["codex"], defaults, roomKey: "/repo/api", launchable }).source).toBe("flag");
    expect(resolveAgentChoice({ defaults, roomKey: "/repo/api", launchable })).toEqual({ agents: ["grok", "codex"], source: "room", unavailable: [] });
    expect(resolveAgentChoice({ defaults, roomKey: "/repo", launchable })).toEqual({ agents: ["claude"], source: "default", unavailable: [] });
    expect(resolveAgentChoice({ defaults: {}, roomKey: "/repo", launchable: ["codex", "grok"] }))
      .toEqual({ agents: ["codex"], source: "pair", unavailable: [] });
    // A saved agent that cannot start is reported, not replaced.
    expect(resolveAgentChoice({ defaults, roomKey: "/repo/api", launchable: ["claude", "codex"] }))
      .toEqual({ agents: ["codex"], source: "room", unavailable: ["grok"] });
  });

  test("saves keep other rooms' overrides and refuse to overwrite a malformed file", () => {
    const dataDir = tempDir("tt-launch-defaults-");
    saveAgentChoice(dataDir, ["claude", "codex"], "/repo/a", "every");
    saveAgentChoice(dataDir, ["grok"], "/repo/a", "room");
    saveAgentChoice(dataDir, ["codex"], "/repo/b", "room");
    expect(readLaunchDefaults(dataDir)).toEqual({ agents: ["claude", "codex"], rooms: { "/repo/a": ["grok"], "/repo/b": ["codex"] } });

    // Saving for every room drops this room's override and keeps the others.
    saveAgentChoice(dataDir, ["codex"], "/repo/a", "every");
    expect(readLaunchDefaults(dataDir)).toEqual({ agents: ["codex"], rooms: { "/repo/b": ["codex"] } });

    fs.writeFileSync(launchDefaultsPath(dataDir), "{ not json");
    expect(() => readLaunchDefaults(dataDir)).toThrow(/launch\.json is not a valid tt up agent choice.*Fix or delete it/);
    expect(() => saveAgentChoice(dataDir, ["claude"], "/repo/a", "every")).toThrow(/Fix or delete it/);
    expect(fs.readFileSync(launchDefaultsPath(dataDir), "utf8")).toBe("{ not json");
    fs.writeFileSync(launchDefaultsPath(dataDir), JSON.stringify({ agents: ["claude", "gemini"] }));
    expect(() => readLaunchDefaults(dataDir)).toThrow(/distinct agents/);
  });
});

function setup(installed: string[] = ["claude", "codex", "grok", "opencode", "agy"]) {
  const root = tempDir("tt-up-choice-");
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ["tt", ...installed]) {
    fs.writeFileSync(path.join(bin, process.platform === "win32" ? `${name}.cmd` : name), "#!/bin/sh\n", { mode: 0o755 });
  }
  for (const dir of [[".claude", "skills"], [".agents", "skills"]]) {
    const skill = path.join(home, ...dir, "talking-stick");
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, "SKILL.md"), "# skill\n");
  }
  const herdr = new FakeHerdr();
  const runtime = { commands: {
    listRooms: () => ({ rooms: [{ canonical_path: repo, room_id: "room-1", state: "idle" }] }),
    getRoomState: () => ({ members: herdr.members() })
  } } as unknown as Runtime;
  const up = async (args: string[], options: { tty?: boolean; markers?: NodeJS.ProcessEnv; pick?: AgentPickerPrompt } = {}) => {
    const output: string[] = [];
    const progress: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true; });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { progress.push(String(chunk)); return true; });
    try {
      await handleUpCommand(runtime, parseCommand(["up", "--path", repo, ...args]), {
        env: { PATH: bin, TALKING_STICK_DATA_DIR: dataDir, HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", ...options.markers },
        homeDir: home, runner: herdr.runner, readStartTime: (pid) => herdr.startTimes.get(pid) ?? null,
        stdinIsTTY: options.tty ?? false, stdoutIsTTY: options.tty ?? false,
        startLocalChat: async () => {},
        pickAgents: options.pick
      });
    } finally { stdout.mockRestore(); stderr.mockRestore(); }
    return { output: output.join(""), progress: progress.join("") };
  };
  const launched = () => herdr.calls.filter((call) => call[1] === "split").length;
  return { up, dataDir, repo, launched };
}

describe("tt up agent choice", () => {
  test("a person's first plain tt up asks, saves the choice and launches it", async () => {
    const { up, dataDir, launched } = setup();
    const pick = vi.fn<AgentPickerPrompt>(async (picker) => {
      expect([...picker.checked]).toEqual(["claude", "codex"]);
      return { agents: ["claude", "grok"], scope: "every" };
    });
    const { progress } = await up(["--text"], { tty: true, pick });
    expect(pick).toHaveBeenCalledOnce();
    expect(readLaunchDefaults(dataDir)).toEqual({ agents: ["claude", "grok"] });
    expect(progress).toContain("Saved claude, grok for every room");
    expect(launched()).toBe(2);
    // The saved choice answers the next run without asking.
    await up(["--text"], { tty: true, pick });
    expect(pick).toHaveBeenCalledOnce();
  });

  test("the room scope saves under the selected room's path, and cancelling saves nothing", async () => {
    const { up, dataDir, repo, launched } = setup();
    await up(["--text"], { tty: true, pick: async () => ({ agents: ["codex"], scope: "room" }) });
    expect(readLaunchDefaults(dataDir)).toEqual({ rooms: { [repo]: ["codex"] } });

    const other = setup();
    await other.up(["--text"], { tty: true, pick: async () => null });
    expect(process.exitCode).toBe(130);
    expect(fs.existsSync(launchDefaultsPath(other.dataDir))).toBe(false);
    expect(other.launched()).toBe(0);
    expect(launched()).toBe(1);
  });

  test.each([
    ["--json", ["--json"], true, {}],
    ["--print", ["--print", "--text"], true, {}],
    ["a pipe", ["--text"], false, {}],
    ["a harness shell", ["--text"], true, { CLAUDECODE: "1" }]
  ] as const)("%s never prompts and starts the default pair", async (_label, args, tty, markers) => {
    const { up, dataDir } = setup();
    const pick = vi.fn<AgentPickerPrompt>();
    const { output, progress } = await up([...args], { tty, markers, pick });
    expect(pick).not.toHaveBeenCalled();
    expect(fs.existsSync(launchDefaultsPath(dataDir))).toBe(false);
    if ((args as readonly string[]).includes("--print")) expect(output).toContain("agent choice: claude, codex (default pair");
    expect(progress.includes("Not asking which agents to start")).toBe(Object.keys(markers).length > 0);
  });

  test("--choose asks even in a harness shell, preselecting the saved choice; without a terminal it fails", async () => {
    const { up, dataDir, repo } = setup();
    saveAgentChoice(dataDir, ["codex"], repo, "every");
    const pick = vi.fn<AgentPickerPrompt>(async (picker) => {
      expect([...picker.checked]).toEqual(["codex"]);
      return { agents: ["claude"], scope: "every" };
    });
    await up(["--choose", "--text"], { tty: true, markers: { CLAUDECODE: "1" }, pick });
    expect(pick).toHaveBeenCalledOnce();
    expect(readLaunchDefaults(dataDir).agents).toEqual(["claude"]);
    await expect(up(["--choose", "--text"], { tty: false, pick })).rejects.toThrow(/--choose needs an interactive terminal/);
  });

  test("--agents --save stores a default or a room override without asking", async () => {
    const { up, dataDir, repo } = setup();
    await up(["--agents", "codex,grok", "--save", "--json"]);
    await up(["--agents", "claude", "--save", "--room", "--json"]);
    expect(readLaunchDefaults(dataDir)).toEqual({ agents: ["codex", "grok"], rooms: { [repo]: ["claude"] } });
    await expect(up(["--save", "--json"])).rejects.toThrow(/--save stores the agents named with --agents/);
    await expect(up(["--agents", "claude", "--choose"])).rejects.toThrow(/mutually exclusive/);
    await expect(up(["--agents", "claude", "--save", "--print"])).rejects.toThrow(/--print changes nothing/);
  });

  test("a room override beats the default and a saved agent that is gone is reported, not replaced", async () => {
    const { up, dataDir, repo } = setup(["claude", "codex"]);
    saveAgentChoice(dataDir, ["claude", "codex"], repo, "every");
    saveAgentChoice(dataDir, ["grok", "codex"], repo, "room");
    const { output } = await up(["--print", "--json"]);
    const plan = JSON.parse(output);
    expect(plan.agents.map((agent: { agent: string }) => agent.agent)).toEqual(["codex"]);
    expect(plan.checks).toContainEqual(expect.objectContaining({ name: "saved agents", status: "uncertain", detail: "grok is saved but cannot start here." }));
    expect(plan.checks.find((check: { name: string }) => check.name === "agent choice").detail).toContain("saved for this room");

    saveAgentChoice(dataDir, ["grok"], repo, "room");
    await expect(up(["--print", "--json"])).rejects.toThrow(/None of the saved agents \(grok\) can start here/);
  });

  test("a saved agent that cannot start asks a person again, even when it was the only one", async () => {
    const { up, dataDir, repo } = setup(["claude", "codex"]);
    saveAgentChoice(dataDir, ["grok"], repo, "room");
    const pick = vi.fn<AgentPickerPrompt>(async (picker) => {
      expect(picker.rows.find((row) => row.agent === "grok")?.unavailable).toBe("saved but not installed");
      expect(picker.checked.size).toBe(0);
      expect(picker.scope).toBe("room");
      return { agents: ["codex"], scope: "room" };
    });
    await up(["--text"], { tty: true, pick });
    expect(pick).toHaveBeenCalledOnce();
    expect(readLaunchDefaults(dataDir).rooms).toEqual({ [repo]: ["codex"] });
  });

  test.each(["text", "json"])("a non-interactive %s launch reports a skipped saved agent", async (format) => {
    const { up, dataDir, repo, launched } = setup(["claude", "codex"]);
    saveAgentChoice(dataDir, ["grok", "codex"], repo, "every");
    const { output, progress } = await up([`--${format}`]);
    expect(launched()).toBe(1);
    if (format === "json") {
      expect(JSON.parse(output).next_steps[0]).toMatch(/^Skipped grok: saved but cannot start here/);
      expect(progress).not.toContain("Skipped grok");
    } else {
      expect(progress).toContain("[tt up] Skipped grok: saved but cannot start here. Run tt up --choose");
    }
  });

  test("an only-Grok machine does not launch Grok on its own", async () => {
    const { up } = setup(["grok"]);
    await expect(up(["--print", "--json"])).rejects.toThrow(/Neither Claude nor Codex/);
  });
});
