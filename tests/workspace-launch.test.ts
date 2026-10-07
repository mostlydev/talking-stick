import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseCommand } from "../src/cli/parser.js";
import { preferredSplitDirection } from "../src/herdr.js";
import type { RoomMember } from "../src/types.js";
import {
  parseLaunchAgents,
  planWorkspaceLaunch,
  type PlanWorkspaceLaunchInput
} from "../src/workspace-launch.js";
import { FakeHerdr } from "./fixtures/fake-herdr.js";

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(options: { executables?: string[]; skills?: Array<"claude" | "shared"> } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tt-up-")));
  tempRoots.push(root);
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  for (const name of options.executables ?? ["tt", "claude", "codex"]) {
    fs.writeFileSync(path.join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
  }
  const skillDirs = { claude: [".claude", "skills"], shared: [".agents", "skills"] };
  for (const kind of options.skills ?? ["claude", "shared"]) {
    const dir = path.join(home, ...skillDirs[kind], "talking-stick");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "# skill\n");
  }
  const herdr = new FakeHerdr();
  const calls = herdr.calls;
  const base: PlanWorkspaceLaunchInput = {
    agents: ["claude", "codex"],
    context_path: repo,
    topology: "here",
    herdr: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" },
    runner: herdr.runner,
    room: null,
    readStartTime: (pid) => herdr.startTimes.get(pid) ?? null,
    env: { PATH: bin },
    homeDir: home
  };
  return { repo, home, calls, base, herdr };
}

function member(agentId: string, harness: string | null, status = "active"): RoomMember {
  return { agent_id: agentId, harness_name: harness, status,
    session_kind: harness ? "harness_cli" : "human_chat", process_liveness: "alive" } as RoomMember;
}

describe("tt up planning", () => {
  test("parses an explicit, unique, supported agent list", () => {
    expect(parseLaunchAgents("claude, codex")).toEqual(["claude", "codex"]);
    expect(() => parseLaunchAgents(undefined)).toThrow(/--agents is required/);
    expect(() => parseLaunchAgents("claude,claude")).toThrow(/more than once/);
    expect(() => parseLaunchAgents("gemini")).toThrow(/Unsupported agent "gemini"/);
  });

  test("topology flags are booleans that never swallow the next argument", () => {
    const parsed = parseCommand(["up", "--new-tab", "--agents", "claude", "--print"]);
    expect(parsed.options.get("new-tab")).toBe(true);
    expect(parsed.options.get("agents")).toBe("claude");
    expect(parseCommand(["up", "--new-workspace", "extra"]).positionals).toEqual(["extra"]);
  });

  test("previews a current-tab launch using only read-only Herdr calls", () => {
    const { base, calls, repo, home } = fixture();
    const plan = planWorkspaceLaunch(base);

    expect(calls).toEqual([["pane", "layout", "--pane", "w1:p1"], ["agent", "list"]]);
    expect(plan.status).toBe("ready");
    expect(plan.chat).toEqual({ action: "launch" });
    expect(plan.agents.map((agent) => [agent.agent, agent.action, agent.prompt_delivery])).toEqual([
      ["claude", "launch", "initial_argument"],
      ["codex", "launch", "initial_argument"]
    ]);
    expect(plan.agents[0].prompt).toContain(path.join(home, ".claude/skills/talking-stick/SKILL.md"));
    expect(plan.agents[0].prompt).toContain(repo);
    expect(plan.agents[0].prompt).toMatch(/Do not claim the stick/);
    expect(plan.steps.map((step) => step.argv)).toEqual([
      ["herdr", "pane", "split", "--pane", "w1:p1", "--direction", "right", "--cwd", repo, "--no-focus"],
      ["herdr", "pane", "run", "<chat-pane>", "tt chat"],
      ["herdr", "pane", "split", "--pane", "<chat-pane>", "--direction", "down", "--cwd", repo, "--no-focus"],
      ["herdr", "agent", "start", plan.agents[0].herdr_name, "--kind", "claude", "--pane", "<claude-pane>", "--timeout", "60000", "--", plan.agents[0].prompt],
      ["herdr", "pane", "split", "--pane", "<claude-pane>", "--direction", "down", "--cwd", repo, "--no-focus"],
      ["herdr", "agent", "start", plan.agents[1].herdr_name, "--kind", "codex", "--pane", "<codex-pane>", "--timeout", "60000", "--", plan.agents[1].prompt]
    ]);
  });

  test("a new tab anchors chat and places agents beside then below it", () => {
    const { base, repo } = fixture();
    const plan = planWorkspaceLaunch({ ...base, topology: "new-tab" });
    expect(plan.steps[0].argv).toEqual([
      "herdr", "tab", "create", "--workspace", "w1", "--cwd", repo, "--label", "talking-stick", "--no-focus"
    ]);
    const splits = plan.steps.filter((step) => step.argv[2] === "split").map((step) => step.argv[6]);
    expect(splits).toEqual(["right", "down"]);
  });

  test("grok is experimental and uses an interactive positional prompt", () => {
    const { base } = fixture({ executables: ["tt", "claude", "codex"] });
    const plan = planWorkspaceLaunch({ ...base, agents: ["grok"] });
    expect(plan.agents[0]).toMatchObject({ agent: "grok", experimental: true, prompt_delivery: "initial_argument" });
    expect(plan.checks.find((check) => check.name === "grok executable")?.status).toBe("uncertain");
    expect(plan.status).toBe("ready");
    const argv = plan.steps.map((step) => step.argv.slice(0, 3).join(" "));
    expect(argv.at(-1)).toEqual("herdr agent start");
    expect(plan.steps.at(-1)?.argv.slice(-2)).toEqual(["--", plan.agents[0].prompt]);
    expect(plan.steps.at(-1)?.argv).not.toContain("--single");
  });

  test("requires identity confirmation for active agent candidates and skips a live chat console", () => {
    const { base, repo } = fixture();
    const plan = planWorkspaceLaunch({
      ...base,
      room: {
        room_id: "room-1",
        members: [
          member("claude:aaaa", "claude"),
          member("codex:old", "codex", "inactive"),
          member("human:op:chat:1234", null)
        ]
      }
    });
    expect(plan.chat).toMatchObject({ action: "skip" });
    expect(plan.agents.map((agent) => agent.action)).toEqual(["inspect", "launch"]);
    expect(plan.status).toBe("needs_confirmation");
    expect(plan.agents[0].reason).toContain("no Herdr pane reports its session");
    // Codex takes the fresh split directly; no chat command is run.
    expect(plan.steps.map((step) => step.argv.slice(0, 3).join(" "))).toEqual([
      "herdr pane split", "herdr agent start"
    ]);
    expect(plan.steps[1].argv).toContain("<anchor-pane>");
    expect(plan.steps[0].argv).toContain(repo);
  });

  test("room membership alone cannot prove launch completion", () => {
    const { base } = fixture();
    const plan = planWorkspaceLaunch({
      ...base,
      room: { room_id: "room-1", members: [member("claude:a", "claude"), member("codex:b", "codex"), member("human:op:chat:1", null)] }
    });
    expect(plan.status).toBe("needs_confirmation");
    expect(plan.steps).toEqual([]);
  });

  test("unconfirmed chat liveness cannot be presented as a reusable console", () => {
    const { base } = fixture();
    const plan = planWorkspaceLaunch({ ...base, room: { room_id: "room-1", members: [
      { ...member("human:op:chat:1", null), process_liveness: "unknown" }
    ] } });
    expect(plan.chat.action).toBe("inspect");
    expect(plan.status).toBe("needs_confirmation");
    expect(plan.steps.some((step) => step.argv[2] === "run")).toBe(false);
  });

  test("different canonical repos with the same basename get different valid names", () => {
    const { base, repo } = fixture();
    const other = path.join(path.dirname(repo), "other", "repo");
    fs.mkdirSync(other, { recursive: true });
    const first = planWorkspaceLaunch(base).agents[0].herdr_name;
    const second = planWorkspaceLaunch({ ...base, context_path: other }).agents[0].herdr_name;
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    expect(second).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  });

  test("a member proven by Herdr session, process, and start time is skipped", () => {
    const { base, herdr } = fixture();
    herdr.addAgent("w1:p9", "claude");
    const members = herdr.members();
    const plan = planWorkspaceLaunch({ ...base, room: { room_id: "room-1", members } });
    expect(plan.agents[0]).toMatchObject({ agent: "claude", action: "skip" });
    expect(plan.agents[0].reason).toContain("confirmed in pane w1:p9");
    expect(plan.agents[1].action).toBe("launch");
    expect(plan.status).toBe("ready");
  });

  test("a different process incarnation, provisional identity, or missing Herdr session is not proof", () => {
    const restarted = fixture();
    const agent = restarted.herdr.addAgent("w1:p9", "claude");
    const members = restarted.herdr.members();
    restarted.herdr.startTimes.set(agent.pid, "Thu Oct  8 09:00:00 2026");
    const plan = planWorkspaceLaunch({ ...restarted.base, room: { room_id: "r", members } });
    expect(plan.agents[0]).toMatchObject({ action: "inspect" });
    expect(plan.agents[0].reason).toContain("different process incarnation");

    const noSession = fixture();
    noSession.herdr.addAgent("w1:p9", "codex", { session: null });
    const provisional = noSession.herdr.members();
    const noSessionPlan = planWorkspaceLaunch({ ...noSession.base, room: { room_id: "r", members: provisional } });
    expect(noSessionPlan.agents[1]).toMatchObject({ action: "inspect" });
  });

  test("an unconfirmed earlier launch or a clashing Herdr name is surfaced, not relaunched", () => {
    const earlier = fixture();
    earlier.herdr.addAgent("w1:p4", "codex", { session: null });
    const plan = planWorkspaceLaunch({ ...earlier.base, record: {
      canonical_path: earlier.repo, chat_pane_id: null, updated_at: "",
      agents: { codex: { herdr_name: "x", pane_id: "w1:p4", state: "ambiguous", updated_at: "" } }
    } });
    expect(plan.agents[1]).toMatchObject({ action: "inspect" });
    expect(plan.agents[1].reason).toContain("pane w1:p4 (ambiguous)");

    const clash = fixture();
    const name = planWorkspaceLaunch(clash.base).agents[0].herdr_name;
    clash.herdr.addAgent("w1:p7", "claude", { name, session: null });
    const clashPlan = planWorkspaceLaunch(clash.base);
    expect(clashPlan.agents[0].reason).toContain(`${name} is already used by pane w1:p7`);
  });

  test("blocks before any step outside Herdr or without an installed skill", () => {
    const outside = fixture();
    const noHerdr = planWorkspaceLaunch({ ...outside.base, herdr: null });
    expect(noHerdr.status).toBe("blocked");
    expect(noHerdr.steps).toEqual([]);
    expect(outside.calls).toEqual([]);

    const missing = fixture({ skills: ["shared"] });
    const plan = planWorkspaceLaunch(missing.base);
    expect(plan.status).toBe("blocked");
    expect(plan.checks.find((check) => check.name === "claude skill")).toMatchObject({
      status: "failed",
      remedy: "tt install claude-code"
    });
  });

  test("requires tt on PATH even when a harness executable may resolve in an interactive shell", () => {
    const { base } = fixture({ executables: ["claude", "codex"] });
    const plan = planWorkspaceLaunch(base);
    expect(plan.status).toBe("blocked");
    expect(plan.checks.find((check) => check.name === "tt executable")?.status).toBe("failed");
  });

  test("a failed layout read blocks the plan", () => {
    const { base } = fixture();
    const plan = planWorkspaceLaunch({
      ...base,
      runner: () => {
        throw Object.assign(new Error("exit 1"), { stderr: "no such pane" });
      }
    });
    expect(plan.status).toBe("blocked");
    expect(plan.checks.find((check) => check.name === "herdr")?.detail).toMatch(/no such pane/);
  });

  test("splits wide panes right and tall panes down", () => {
    expect(preferredSplitDirection({ width: 200, height: 50 })).toBe("right");
    expect(preferredSplitDirection({ width: 80, height: 60 })).toBe("down");
  });
});
