import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { handleUpCommand, renderPlan, renderResult } from "../src/cli/up.js";
import { parseCommand } from "../src/cli/parser.js";
import type { Runtime } from "../src/cli/runtime.js";
import { acquireLaunchLock, readLaunchRecord, launchRecordPath, writeLaunchRecord } from "../src/launch-record.js";
import type { RoomMember } from "../src/types.js";
import {
  planWorkspaceLaunch,
  type LaunchAgent,
  type LaunchTopology
} from "../src/workspace-launch.js";
import { executeWorkspaceLaunch } from "../src/workspace-launch-run.js";
import { FakeHerdr } from "./fixtures/fake-herdr.js";

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tt-up-run-")));
  tempRoots.push(root);
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ["tt", "claude", "codex", "grok"]) {
    fs.writeFileSync(path.join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
  }
  for (const dir of [[".claude", "skills"], [".agents", "skills"]]) {
    const skill = path.join(home, ...dir, "talking-stick");
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, "SKILL.md"), "# skill\n");
  }
  const herdr = new FakeHerdr();
  const readStartTime = (pid: number) => herdr.startTimes.get(pid) ?? null;
  let clock = 0;
  let readMembers: () => RoomMember[] | null = () => herdr.members();

  const plan = (agents: LaunchAgent[], topology: LaunchTopology = "here") =>
    planWorkspaceLaunch({
      agents,
      context_path: repo,
      topology,
      herdr: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" },
      runner: herdr.runner,
      room: { room_id: "room-1", members: herdr.members() },
      readStartTime,
      record: readLaunchRecord(dataDir, repo),
      env: { PATH: bin },
      homeDir: home
    });
  const run = (agents: LaunchAgent[], topology: LaunchTopology = "here") =>
    executeWorkspaceLaunch(plan(agents, topology), {
      runner: herdr.runner,
      readStartTime,
      readMembers: () => readMembers(),
      dataDir,
      record: readLaunchRecord(dataDir, repo),
      joinTimeoutMs: 10_000,
      sleep: async (ms) => { clock += ms; },
      now: () => clock
    });
  const mutations = () => herdr.calls.filter((call) =>
    ["split", "create", "run", "start", "prompt"].includes(call[1])
  );
  return {
    herdr, repo, home, bin, dataDir, run, plan, mutations,
    setMembers: (reader: () => RoomMember[] | null) => { readMembers = reader; }
  };
}

describe("tt up execution", () => {
  test("rejects an ancestor-room mismatch before launching into the wrong room", async () => {
    const { herdr, repo, dataDir, home, bin } = setup();
    const nested = path.join(repo, "child");
    fs.mkdirSync(nested);
    const runtime = { commands: { listRooms: () => ({ rooms: [{ canonical_path: repo, room_id: "parent" }] }) } } as unknown as Runtime;
    await expect(handleUpCommand(runtime,
      parseCommand(["up", "--agents", "claude", "--path", nested, "--print", "--json"]),
      { env: { PATH: bin, TALKING_STICK_DATA_DIR: dataDir, HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }, homeDir: home, runner: herdr.runner }
    )).rejects.toThrow(`Use --path ${repo}`);
    expect(herdr.calls).toEqual([]);
  });

  test("rejects a subdirectory whose new room would be created at its workspace root", async () => {
    const { herdr, repo, dataDir, home, bin } = setup();
    const nested = path.join(repo, "child");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(repo, "package.json"), "{}");
    const runtime = { commands: { listRooms: () => ({ rooms: [] }) } } as unknown as Runtime;
    await expect(handleUpCommand(runtime,
      parseCommand(["up", "--agents", "claude", "--path", nested, "--print", "--json"]),
      { env: { PATH: bin, TALKING_STICK_DATA_DIR: dataDir, HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }, homeDir: home, runner: herdr.runner }
    )).rejects.toThrow(`Use --path ${repo}`);
    expect(herdr.calls).toEqual([]);
  });

  test("preview --forget leaves its record untouched and failed preflight never discards it", async () => {
    const { herdr, dataDir, repo, home, bin } = setup();
    const record = { canonical_path: repo, chat_pane_id: null, agents: {},
      anchor: { state: "creating" as const, pane_id: null }, updated_at: "before" };
    writeLaunchRecord(dataDir, record);
    const runtime = { commands: { listRooms: () => ({ rooms: [] }) } } as unknown as Runtime;
    const env = { PATH: bin, TALKING_STICK_DATA_DIR: dataDir, HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" };
    const output: string[] = [];
    const previousExit = process.exitCode;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true; });
    try {
      await handleUpCommand(runtime, parseCommand(["up", "--agents", "claude", "--path", repo, "--forget", "--print", "--json"]),
        { env, homeDir: home, runner: herdr.runner });
      expect(JSON.parse(output.join("")).chat.action).toBe("launch");
      expect(readLaunchRecord(dataDir, repo)).toEqual(record);
      await handleUpCommand(runtime, parseCommand(["up", "--agents", "claude", "--path", repo, "--forget", "--json"]),
        { env: { ...env, HERDR_ENV: "0" }, homeDir: home, runner: herdr.runner });
      expect(readLaunchRecord(dataDir, repo)).toEqual(record);
    } finally { stdout.mockRestore(); process.exitCode = previousExit; }
  });

  test("an ambiguous anchor persists intent and a repeat creates no additional panes", async () => {
    const { run, herdr, repo, dataDir, mutations } = setup();
    herdr.ambiguousSplitAt = 1;
    expect((await run(["claude"])).status).toBe("partial");
    expect(readLaunchRecord(dataDir, repo)?.anchor?.state).toBe("ambiguous");
    const before = mutations().length;
    const repeat = await run(["claude"]);
    expect(repeat.chat.state).toBe("inspect");
    expect(mutations().length).toBe(before);
  });

  test("an ambiguous agent split with an unknown pane ID is not repeated", async () => {
    const { run, herdr, mutations, repo, dataDir } = setup();
    herdr.ambiguousSplitAt = 2;
    await run(["claude"]);
    expect(readLaunchRecord(dataDir, repo)?.agents.claude).toMatchObject({ state: "ambiguous", pane_id: null });
    const before = mutations().length;
    const repeat = await run(["claude"]);
    expect(repeat.agents[0].state).toBe("inspect");
    expect(mutations().length).toBe(before);
  });

  test("an interrupted chat submission is not sent again while registration is absent", async () => {
    const { run, herdr, setMembers, mutations, repo, dataDir } = setup();
    herdr.ambiguousChat = true;
    setMembers(() => []);
    await run(["claude"]);
    expect(readLaunchRecord(dataDir, repo)?.chat_state).toBe("ambiguous");
    for (const pane of herdr.panes.values()) pane.chat = false;
    const before = mutations().length;
    const repeat = await run(["claude"]);
    expect(repeat.chat.state).toBe("inspect");
    expect(mutations().length).toBe(before);
  });

  test("a crash between anchor creation and its reply preserves inspect intent", () => {
    const { plan, dataDir, repo } = setup();
    writeLaunchRecord(dataDir, { canonical_path: repo, chat_pane_id: null, agents: {},
      anchor: { state: "creating", pane_id: null }, updated_at: new Date().toISOString() });
    const repeat = plan(["claude"]);
    expect(repeat.chat.action).toBe("inspect");
    expect(repeat.steps.some((step) => step.kind === "chat")).toBe(false);
  });

  test("a live launch lock cannot expire by age and release cannot delete a replacement", () => {
    const { dataDir, repo } = setup();
    const release = acquireLaunchLock(dataDir, repo);
    const lock = `${launchRecordPath(dataDir, repo)}.lock`;
    fs.utimesSync(lock, new Date(0), new Date(0));
    expect(() => acquireLaunchLock(dataDir, repo, { timeoutMs: 0 })).toThrow(/may be launching/);
    const ownerPath = path.join(lock, "owner.json");
    const replacement = { ...JSON.parse(fs.readFileSync(ownerPath, "utf8")), token: "replacement" };
    fs.writeFileSync(ownerPath, JSON.stringify(replacement));
    release();
    expect(fs.existsSync(lock)).toBe(true);
  });

  test("a lock with a proven dead process owner can be recovered", () => {
    const { dataDir, repo } = setup();
    const oldRelease = acquireLaunchLock(dataDir, repo);
    const release = acquireLaunchLock(dataDir, repo, { timeoutMs: 0, inspector: { inspect: () => null } });
    oldRelease();
    expect(() => acquireLaunchLock(dataDir, repo, { timeoutMs: 0 })).toThrow(/may be launching/);
    release();
  });

  test("launches chat and agents, then confirms each join by session and process", async () => {
    const { run, herdr, dataDir, repo } = setup();
    const result = await run(["claude", "codex"]);

    expect(result.status).toBe("launched");
    expect(result.chat).toMatchObject({ state: "opened", pane_id: "w1:p2" });
    expect(result.agents.map((agent) => [agent.agent, agent.state, agent.pane_id])).toEqual([
      ["claude", "confirmed", "w1:p3"],
      ["codex", "confirmed", "w1:p4"]
    ]);
    expect(result.agents[0].member_id).toMatch(/^claude:/);
    // Each agent splits from the pane created just before it, with real IDs.
    const splits = herdr.calls.filter((call) => call[1] === "split").map((call) => call[3]);
    expect(splits).toEqual(["w1:p1", "w1:p2", "w1:p3"]);
    const record = readLaunchRecord(dataDir, repo)!;
    expect(record.chat_pane_id).toBe("w1:p2");
    expect(record.agents.claude).toMatchObject({ pane_id: "w1:p3", state: "confirmed" });
  });

  test("a repeat launch after success creates nothing", async () => {
    const { run, mutations, plan } = setup();
    const first = await run(["claude", "codex"]);
    expect(renderResult(plan(["claude"]), first)).toMatch(/claude: confirmed \(w1:p3\) as claude:/);
    const before = mutations().length;
    const preview = renderPlan(plan(["claude", "codex"]));
    expect(preview).toMatch(/claude: skip — claude:\d+ is confirmed in pane w1:p3/);
    expect(preview).toContain("Nothing to launch");
    const repeat = await run(["claude", "codex"]);
    expect(repeat.status).toBe("nothing_to_do");
    expect(repeat.agents.map((agent) => agent.state)).toEqual(["skipped", "skipped"]);
    expect(mutations().length).toBe(before);
  });

  test("closed recorded panes allow a later fresh launch", async () => {
    const { run, herdr } = setup();
    const first = await run(["claude"]);
    expect(first.status).toBe("launched");
    herdr.panes.delete(first.chat.pane_id!);
    herdr.panes.delete(first.agents[0].pane_id!);
    const repeat = await run(["claude"]);
    expect(repeat.status).toBe("launched");
    expect(repeat.chat.pane_id).not.toBe(first.chat.pane_id);
  });

  test("a recorded shell pane stays occupied even when not in the agent list", () => {
    const { plan, herdr, repo, dataDir } = setup();
    herdr.panes.set("w1:p8", { id: "w1:p8", chat: false, agent: null });
    writeLaunchRecord(dataDir, { canonical_path: repo, chat_pane_id: null, agents: {
      claude: { herdr_name: "old", state: "pane_created", pane_id: "w1:p8", updated_at: "now" }
    }, updated_at: "now" });
    expect(plan(["claude"]).agents[0].action).toBe("inspect");
  });

  test("chat intent is preserved even after an unrelated later anchor closes", () => {
    const { plan, herdr, repo, dataDir } = setup();
    herdr.panes.set("w1:p8", { id: "w1:p8", chat: false, agent: null });
    writeLaunchRecord(dataDir, { canonical_path: repo, chat_pane_id: "w1:p8", chat_state: "ambiguous",
      anchor: { state: "created", pane_id: "closed-later-agent-anchor" }, agents: {}, updated_at: "now" });
    expect(plan(["claude"]).chat.action).toBe("inspect");
  });

  test("a submitted chat command without a live console cannot report full success", async () => {
    const { run, herdr, setMembers } = setup();
    setMembers(() => herdr.members().filter((member) => member.session_kind !== "human_chat"));
    const result = await run(["claude"]);
    expect(result.status).toBe("partial");
    expect(result.agents[0].state).toBe("confirmed");
    expect(result.chat.state).toBe("submitted");
    expect(result.next_steps.join("\n")).toContain("has not proven it is running");
  });

  test("waits for delayed chat registration after all agents have joined", async () => {
    const { run, herdr, setMembers } = setup();
    let polls = 0;
    setMembers(() => ++polls < 2
      ? herdr.members().filter((member) => member.session_kind !== "human_chat") : herdr.members());
    const result = await run(["claude"]);
    expect(result.status).toBe("launched");
    expect(result.chat.state).toBe("opened");
    expect(polls).toBe(2);
  });

  test("an unrelated chat process cannot satisfy the created pane's console proof", async () => {
    const { run, herdr, setMembers } = setup();
    setMembers(() => herdr.members().map((member) => member.session_kind === "human_chat"
      ? { ...member, pid: member.pid! + 1000 } : member));
    expect((await run(["claude"])).chat.state).toBe("submitted");
  });

  test("a new tab hosts chat in its root pane", async () => {
    const { run, herdr } = setup();
    const result = await run(["codex"], "new-tab");
    expect(herdr.calls.find((call) => call[1] === "create")?.slice(0, 4)).toEqual(["tab", "create", "--workspace", "w1"]);
    expect(result.chat.pane_id).toBe("w1:p2");
    expect(result.agents[0]).toMatchObject({ state: "confirmed", pane_id: "w1:p3" });
  });

  test("a blocked start is reported for the operator and other agents continue", async () => {
    const { run, herdr } = setup();
    herdr.startBehavior.claude = "not_ready";
    const result = await run(["claude", "codex"]);
    expect(result.status).toBe("partial");
    expect(result.agents[0]).toMatchObject({ state: "blocked", pane_id: "w1:p3" });
    expect(result.agents[1].state).toBe("confirmed");
    expect(result.next_steps.join("\n")).toMatch(/claude in pane w1:p3 is waiting on a dialog/);
    // No prompt or dialog answer is ever sent to the blocked pane.
    expect(herdr.calls.filter((call) => call[1] === "prompt" || call[1] === "send-keys")).toEqual([]);
  });

  test("an uncertain start is never retried, and a rerun inspects instead of relaunching", async () => {
    const { run, herdr, mutations } = setup();
    herdr.startBehavior.codex = "timeout";
    const first = await run(["codex"]);
    expect(first.agents[0]).toMatchObject({ state: "ambiguous", pane_id: "w1:p3" });
    expect(herdr.calls.filter((call) => call[1] === "start")).toHaveLength(1);

    // The timed-out start did launch something in that pane after all.
    herdr.addAgent("w1:p3", "codex", { session: null }).joins = false;
    const before = mutations().length;
    const second = await run(["codex"]);
    expect(second.status).toBe("partial");
    expect(second.agents[0].state).toBe("inspect");
    expect(second.agents[0].detail).toContain("pane w1:p3 (ambiguous)");
    expect(mutations().length).toBe(before);
  });

  test("an agent that never proves its join is reported after the bounded wait", async () => {
    const { run, herdr } = setup();
    herdr.startBehavior.codex = "never_joins";
    const result = await run(["codex"]);
    expect(result.status).toBe("partial");
    expect(result.agents[0].state).toBe("started");
    expect(result.agents[0].detail).toMatch(/no verified join within 10s/);
  });

  test("an agent without a Herdr session stays unconfirmed even after joining", async () => {
    const { run, herdr } = setup();
    herdr.startBehavior.grok = "no_session";
    const result = await run(["grok"]);
    expect(result.agents[0].state).toBe("started");
    expect(result.agents[0].detail).toMatch(/no verified harness session|no agent session|Herdr reports no/);
  });

  test("a join that lands after a few polls is confirmed", async () => {
    const { run, herdr, setMembers } = setup();
    let polls = 0;
    setMembers(() => (++polls < 3 ? [] : herdr.members()));
    const result = await run(["claude"]);
    expect(result.agents[0].state).toBe("confirmed");
    expect(polls).toBe(3);
  });

  test("a failed anchor stops before any agent starts", async () => {
    const { run, herdr } = setup();
    herdr.failSplit = true;
    const result = await run(["claude"]);
    expect(result.status).toBe("partial");
    expect(result.agents[0].state).toBe("failed");
    expect(herdr.calls.filter((call) => call[1] === "start")).toEqual([]);
  });

  test("a blocked plan performs no Herdr mutation", async () => {
    const { herdr, dataDir } = setup();
    const result = await executeWorkspaceLaunch(
      { ...setup().plan(["claude"]), status: "blocked" },
      { runner: herdr.runner, readStartTime: () => null, readMembers: () => [], dataDir, record: null }
    );
    expect(result.status).toBe("blocked");
    expect(herdr.calls).toEqual([]);
  });

  test("a concurrent launcher for the same path is refused", () => {
    const { dataDir, repo } = setup();
    const release = acquireLaunchLock(dataDir, repo);
    try {
      expect(() => acquireLaunchLock(dataDir, repo, { timeoutMs: 0 })).toThrow(/may be launching/);
    } finally {
      release();
    }
    acquireLaunchLock(dataDir, repo, { timeoutMs: 0 })();
  });
});
