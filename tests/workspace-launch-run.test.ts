import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { renderPlan, renderResult } from "../src/cli/up.js";
import { acquireLaunchLock, readLaunchRecord } from "../src/launch-record.js";
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
    herdr, repo, dataDir, run, plan, mutations,
    setMembers: (reader: () => RoomMember[] | null) => { readMembers = reader; }
  };
}

describe("tt up execution", () => {
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
      expect(() => acquireLaunchLock(dataDir, repo, { timeoutMs: 0 })).toThrow(/already launching/);
    } finally {
      release();
    }
    acquireLaunchLock(dataDir, repo, { timeoutMs: 0 })();
  });
});
