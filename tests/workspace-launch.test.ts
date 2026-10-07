import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseCommand } from "../src/cli/parser.js";
import { preferredSplitDirection, type HerdrRunner } from "../src/herdr.js";
import type { RoomMember } from "../src/types.js";
import {
  parseLaunchAgents,
  planWorkspaceLaunch,
  type PlanWorkspaceLaunchInput
} from "../src/workspace-launch.js";

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
  const calls: string[][] = [];
  const runner: HerdrRunner = (args) => {
    calls.push([...args]);
    if (args[0] === "pane" && args[1] === "layout") {
      return JSON.stringify({
        result: { layout: { panes: [{ pane_id: "w1:p1", rect: { width: 200, height: 50 } }] } }
      });
    }
    throw new Error(`unexpected herdr call: ${args.join(" ")}`);
  };
  const base: PlanWorkspaceLaunchInput = {
    agents: ["claude", "codex"],
    context_path: repo,
    topology: "here",
    herdr: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" },
    runner,
    room: null,
    env: { PATH: bin },
    homeDir: home
  };
  return { repo, home, calls, base };
}

function member(agentId: string, harness: string | null, status = "active"): RoomMember {
  return { agent_id: agentId, harness_name: harness, status } as RoomMember;
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

    expect(calls).toEqual([["pane", "layout", "--pane", "w1:p1"]]);
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
      ["herdr", "agent", "start", "claude-repo", "--kind", "claude", "--pane", "<claude-pane>", "--", plan.agents[0].prompt],
      ["herdr", "pane", "split", "--pane", "<claude-pane>", "--direction", "down", "--cwd", repo, "--no-focus"],
      ["herdr", "agent", "start", "codex-repo", "--kind", "codex", "--pane", "<codex-pane>", "--", plan.agents[1].prompt]
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

  test("grok is experimental and receives its prompt after start", () => {
    const { base } = fixture({ executables: ["tt", "claude", "codex"] });
    const plan = planWorkspaceLaunch({ ...base, agents: ["grok"] });
    expect(plan.agents[0]).toMatchObject({ agent: "grok", experimental: true, prompt_delivery: "agent_prompt" });
    expect(plan.checks.find((check) => check.name === "grok executable")?.status).toBe("uncertain");
    expect(plan.status).toBe("ready");
    const argv = plan.steps.map((step) => step.argv.slice(0, 3).join(" "));
    expect(argv.slice(-2)).toEqual(["herdr agent start", "herdr agent prompt"]);
    expect(plan.steps.at(-2)?.argv).not.toContain("--");
  });

  test("skips active members of the requested harness and an open chat console", () => {
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
    expect(plan.agents.map((agent) => agent.action)).toEqual(["skip", "launch"]);
    // Codex takes the fresh split directly; no chat command is run.
    expect(plan.steps.map((step) => step.argv.slice(0, 3).join(" "))).toEqual([
      "herdr pane split", "herdr agent start"
    ]);
    expect(plan.steps[1].argv).toContain("<anchor-pane>");
    expect(plan.steps[0].argv).toContain(repo);
  });

  test("an already-complete room needs no steps", () => {
    const { base } = fixture();
    const plan = planWorkspaceLaunch({
      ...base,
      room: { room_id: "room-1", members: [member("claude:a", "claude"), member("codex:b", "codex"), member("human:op:chat:1", null)] }
    });
    expect(plan.status).toBe("ready");
    expect(plan.steps).toEqual([]);
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
