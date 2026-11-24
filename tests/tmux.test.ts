import { describe, expect, test } from "vitest";
import { createdPaneId, HerdrError, listHerdrAgents, paneExists, readPaneLayout, readPaneProcesses, runHerdrJson } from "../src/herdr.js";
import { createTmuxHerdrRunner, readTmuxContext, type TmuxExec } from "../src/tmux.js";
import type { RoomMember } from "../src/types.js";

function fakeTmux(responses: Record<string, string | Error>) {
  const calls: string[][] = [];
  const exec: TmuxExec = (binary, args) => {
    calls.push([binary, ...args]);
    const key = [binary, ...args].join(" ");
    const match = Object.entries(responses).find(([prefix]) => key.startsWith(prefix));
    if (!match) return "";
    if (match[1] instanceof Error) throw match[1];
    return match[1];
  };
  return { exec, calls };
}

const refused = (stderr: string) => Object.assign(new Error("exit 1"), { stderr, status: 1 });

describe("tmux backend", () => {
  test("reads the caller's pane, window and session as Herdr context", () => {
    const { exec } = fakeTmux({ "tmux display-message -p -t %3": "%3\t@2\t$1\n" });
    const runner = createTmuxHerdrRunner({ exec });
    expect(readTmuxContext({ TMUX: "/tmp/tmux-501/default,1,0", TMUX_PANE: "%3" }, runner))
      .toEqual({ pane_id: "%3", tab_id: "@2", workspace_id: "$1" });
    expect(readTmuxContext({ TMUX_PANE: "%3" }, runner)).toBeNull();
  });

  test("reports layout, existence and a missing pane like Herdr", () => {
    const { exec } = fakeTmux({
      "tmux display-message -p -t %3 #{pane_id}\t#{pane_width}": "%3\t200\t50\n",
      "tmux display-message -p -t %3": "%3\t@2\t$1\n",
      // tmux 3.8 prints nothing and exits 0 for an unknown target.
      "tmux display-message -p -t %9": "\n",
      "tmux display-message -p -t %8": refused("can't find pane: %8")
    });
    const runner = createTmuxHerdrRunner({ exec });
    expect(readPaneLayout(runner, "%3")).toEqual({ pane_id: "%3", rect: { width: 200, height: 50 } });
    expect(paneExists(runner, "%3")).toBe(true);
    expect(paneExists(runner, "%9")).toBe(false);
    expect(paneExists(runner, "%8")).toBe(false);
  });

  test("closes only the exact pane and refuses a missing target", () => {
    const { exec, calls } = fakeTmux({ "tmux display-message -p -t %3": "%3\t/dev/ttys011\n" });
    const runner = createTmuxHerdrRunner({ exec });
    expect(runHerdrJson(runner, ["pane", "close", "%3"])).toEqual({});
    expect(() => runHerdrJson(runner, ["pane", "close", "%9"])).toThrow("can't find pane %9");
    expect(calls.filter(call => call[1] === "kill-pane")).toEqual([["tmux", "kill-pane", "-t", "%3"]]);
  });

  test("creates a workspace, splits with the new pane's share, and pins the room", () => {
    const { exec, calls } = fakeTmux({
      "tmux has-session": refused("can't find session: repo"),
      "tmux new-session": "$4\t@7\t1\t%20\trepo\n",
      "tmux split-window": "%21\n"
    });
    const runner = createTmuxHerdrRunner({ exec });
    const created = runHerdrJson(runner, ["workspace", "create", "--cwd", "/repo", "--label", "repo", "--env", "TT_ROOM=r1", "--no-focus"]);
    expect(createdPaneId(created)).toBe("%20");
    expect(created.tab).toMatchObject({ tab_id: "@7", workspace_id: "$4" });
    const split = runHerdrJson(runner, ["pane", "split", "--pane", "%20", "--direction", "down", "--ratio", String(1 / 3), "--cwd", "/repo", "--env", "TT_ROOM=r1", "--no-focus"]);
    expect(createdPaneId(split)).toBe("%21");
    expect(calls).toContainEqual(["tmux", "new-session", "-d", "-s", "repo", "-c", "/repo", "-e", "TT_ROOM=r1", "-P", "-F", expect.any(String)]);
    expect(calls).toContainEqual(["tmux", "split-window", "-d", "-t", "%20", "-v", "-l", "67%", "-c", "/repo", "-e", "TT_ROOM=r1", "-P", "-F", "#{pane_id}"]);
  });

  test("starts an agent by typing its quoted command line and labels the pane", () => {
    const { exec, calls } = fakeTmux({});
    const runner = createTmuxHerdrRunner({ exec });
    runHerdrJson(runner, ["agent", "start", "codex-repo-1234", "--kind", "codex", "--pane", "%21", "--timeout", "60000", "--", "--no-daemon", "Join the room; don't claim."]);
    expect(calls).toEqual([
      ["tmux", "set-option", "-p", "-t", "%21", "@tt_agent", "codex-repo-1234"],
      ["tmux", "set-option", "-p", "-t", "%21", "@tt_kind", "codex"],
      ["tmux", "send-keys", "-t", "%21", "-l", "codex --no-daemon 'Join the room; don'\\''t claim.'"],
      ["tmux", "send-keys", "-t", "%21", "Enter"]
    ]);
  });

  test("lists labelled panes and panes hosting a member's harness, with no busy status", () => {
    const member = { agent_id: "codex:1", harness_name: "codex", harness_pid: 500, harness_session_id: "harness:s-1" } as RoomMember;
    const { exec } = fakeTmux({
      "tmux list-panes": "%20\t/dev/ttys010\t\t\n%21\t/dev/ttys011\tcodex-repo-1234\tcodex\n%22\t/dev/ttys012\t\t\n",
      "ps -o pid=,tty= -p 500": "  500 ttys011\n"
    });
    const agents = listHerdrAgents(createTmuxHerdrRunner({ exec, readMembers: () => [member] }));
    expect(agents).toEqual([{ pane_id: "%21", name: "codex-repo-1234", agent: "codex", session_id: "s-1", status: null }]);
  });

  test("reports the pane terminal's foreground processes", () => {
    const { exec } = fakeTmux({
      "tmux display-message -p -t %21 #{pane_id}\t#{pane_tty}": "%21\t/dev/ttys011\n",
      "ps -t ttys011": "  400 Ss   -zsh\n  500 S+   /opt/homebrew/bin/codex\n"
    });
    expect(readPaneProcesses(createTmuxHerdrRunner({ exec }), "%21")).toEqual([{ pid: 500, argv0: "/opt/homebrew/bin/codex" }]);
  });

  test("a tmux refusal fails definitely; a timeout stays uncertain; unknown verbs are unsupported", () => {
    const { exec } = fakeTmux({
      "tmux switch-client": refused("no current client"),
      "tmux select-window": Object.assign(new Error("ETIMEDOUT"), { killed: true, signal: "SIGTERM", stderr: "" })
    });
    const runner = createTmuxHerdrRunner({ exec });
    const code = (args: string[]) => {
      try { runHerdrJson(runner, args); return "ok"; } catch (error) { return (error as HerdrError).code; }
    };
    expect(code(["workspace", "focus", "$4"])).toBe("invalid_params");
    expect(code(["tab", "focus", "@7"])).toBeNull();
    expect(code(["agent", "prompt", "x", "hi"])).toBe("method_not_found");
  });
});
