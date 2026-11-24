import { execFileSync } from "node:child_process";
import { HERDR_TIMEOUT_MS, type HerdrContext, type HerdrRunner } from "./herdr.js";
import { HARNESS_SESSION_PREFIX } from "./launch-identity.js";
import type { RoomMember } from "./types.js";

// tt up and the Codex pane interrupt speak Herdr's verbs. Inside plain tmux,
// this runner performs each verb with tmux and answers in Herdr's JSON shape,
// so planning, execution, records and join proofs stay backend-neutral.
//
// tmux has no agent detection. "agent list" reports panes tt up labelled plus
// panes whose terminal hosts a room member's harness process; the session id
// it reports is that member's own, so a pane proof rests on the harness pid
// being a foreground process of the pane with the recorded start time. tmux
// has no busy/idle signal either: agent_status is always null.

export type TmuxExec = (binary: "tmux" | "ps", args: readonly string[], timeoutMs: number) => string;

export interface TmuxRunnerOptions {
  env?: NodeJS.ProcessEnv;
  // Members of the room being launched or interrupted, read on demand.
  readMembers?: () => readonly RoomMember[];
  exec?: TmuxExec;
}

// The harness name a member registers, as the agent kind Herdr would report.
const KIND_BY_HARNESS: Record<string, string> = { "claude-code": "claude", antigravity: "agy" };
const FIELD = "\t";

export function readTmuxContext(env: NodeJS.ProcessEnv, runner: HerdrRunner): HerdrContext | null {
  const paneId = env.TMUX_PANE?.trim();
  if (!env.TMUX || !paneId) return null;
  try {
    const result = JSON.parse(runner(["pane", "get", paneId])) as { result?: { pane?: Record<string, unknown> } };
    const pane = result.result?.pane ?? {};
    return {
      pane_id: paneId,
      tab_id: typeof pane.tab_id === "string" ? pane.tab_id : null,
      workspace_id: typeof pane.workspace_id === "string" ? pane.workspace_id : null
    };
  } catch {
    return { pane_id: paneId, tab_id: null, workspace_id: null };
  }
}

export function createTmuxHerdrRunner(options: TmuxRunnerOptions = {}): HerdrRunner {
  const env = options.env ?? process.env;
  const exec: TmuxExec = options.exec ?? ((binary, args, timeoutMs) => execFileSync(
    binary === "tmux" ? env.TMUX_BIN_PATH?.trim() || "tmux" : "ps",
    args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"], env }));
  return (args, runOptions = {}) => {
    const timeoutMs = Math.min(runOptions.timeoutMs ?? HERDR_TIMEOUT_MS, HERDR_TIMEOUT_MS);
    const tmux = (...tmuxArgs: string[]) => {
      try {
        return exec("tmux", tmuxArgs, timeoutMs).replace(/\n$/, "");
      } catch (error) {
        throw tmuxFailure(error);
      }
    };
    return JSON.stringify({ result: perform([...args], tmux, exec, timeoutMs, options.readMembers ?? (() => [])) });
  };
}

function perform(
  args: string[],
  tmux: (...args: string[]) => string,
  exec: TmuxExec,
  timeoutMs: number,
  readMembers: () => readonly RoomMember[]
): Record<string, unknown> {
  const [group, verb] = args;
  const option = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  // Every --env pair becomes the new pane's environment, as with Herdr.
  const envFlags = args.flatMap((arg, index) => args[index - 1] === "--env" ? ["-e", arg] : []);
  const cwd = option("--cwd");
  const at = (...rest: string[]) => [...(cwd ? ["-c", cwd] : []), ...envFlags, ...rest];

  // display-message prints nothing and succeeds for a missing target.
  const describe = (paneId: string, format: string) => {
    const [id, ...fields] = tmux("display-message", "-p", "-t", paneId, `#{pane_id}${FIELD}${format}`).split(FIELD);
    if (id !== paneId) throw failure("pane_not_found", `tmux: can't find pane ${paneId}`);
    return fields;
  };
  if (group === "pane" && verb === "get") {
    const [tabId, workspaceId] = describe(args[2], `#{window_id}${FIELD}#{session_id}`);
    return { pane: { pane_id: args[2], tab_id: tabId, workspace_id: workspaceId } };
  }
  if (group === "pane" && verb === "layout") {
    const paneId = option("--pane")!;
    const [width, height] = describe(paneId, `#{pane_width}${FIELD}#{pane_height}`);
    return { layout: { panes: [{ pane_id: paneId, rect: { width: Number(width), height: Number(height) } }] } };
  }
  if (group === "pane" && verb === "process-info") {
    const [tty] = describe(option("--pane")!, "#{pane_tty}");
    return { process_info: { foreground_processes: foregroundProcesses(exec, tty, timeoutMs) } };
  }
  if (group === "pane" && verb === "split") {
    const ratio = Number(option("--ratio"));
    // Herdr's ratio is the old pane's share; tmux sizes the new pane.
    const size = ratio > 0 && ratio < 1 ? ["-l", `${Math.round((1 - ratio) * 100)}%`] : [];
    const paneId = tmux("split-window", "-d", "-t", option("--pane")!, option("--direction") === "down" ? "-v" : "-h",
      ...size, ...at("-P", "-F", "#{pane_id}"));
    return { pane: { pane_id: paneId } };
  }
  if (group === "pane" && verb === "close") {
    describe(args[2], "#{pane_tty}");
    tmux("kill-pane", "-t", args[2]);
    return {};
  }
  if (group === "pane" && verb === "run") {
    tmux("send-keys", "-t", args[2], "-l", args[3]);
    tmux("send-keys", "-t", args[2], "Enter");
    return {};
  }
  if (group === "pane" && verb === "send-keys") {
    tmux("send-keys", "-t", args[2], ...args.slice(3).map((key) => key === "esc" ? "Escape" : key));
    return {};
  }
  if (group === "workspace" && verb === "create") {
    const label = option("--label") ?? "talking-stick";
    let named = true;
    try {
      tmux("has-session", "-t", `=${label}`);
      named = false;
    } catch {
      // No session by that name; use it.
    }
    const created = tmux("new-session", "-d", ...(named ? ["-s", label] : []), ...at("-P", "-F",
      `#{session_id}${FIELD}#{window_id}${FIELD}#{window_index}${FIELD}#{pane_id}${FIELD}#{session_name}`)).split(FIELD);
    return {
      workspace: { workspace_id: created[0], label: created[4] },
      tab: { tab_id: created[1], workspace_id: created[0], number: Number(created[2]), label: created[4] },
      root_pane: { pane_id: created[3] }
    };
  }
  if (group === "tab" && verb === "create") {
    const label = option("--label") ?? "talking-stick";
    const created = tmux("new-window", "-d", "-t", `${option("--workspace")}:`, "-n", label, ...at("-P", "-F",
      `#{session_id}${FIELD}#{window_id}${FIELD}#{window_index}${FIELD}#{pane_id}`)).split(FIELD);
    return {
      tab: { tab_id: created[1], workspace_id: created[0], number: Number(created[2]), label },
      root_pane: { pane_id: created[3] }
    };
  }
  if (group === "tab" && verb === "focus") {
    tmux("select-window", "-t", args[2]);
    return {};
  }
  if (group === "workspace" && verb === "focus") {
    // Needs an attached client; otherwise the caller reports manual selection.
    tmux("switch-client", "-t", args[2]);
    return {};
  }
  if (group === "agent" && verb === "start") {
    const paneId = option("--pane")!;
    const kind = option("--kind")!;
    const separator = args.indexOf("--");
    const command = [kind, ...(separator >= 0 ? args.slice(separator + 1) : [])].map(shellQuote).join(" ");
    tmux("set-option", "-p", "-t", paneId, "@tt_agent", args[2]);
    tmux("set-option", "-p", "-t", paneId, "@tt_kind", kind);
    tmux("send-keys", "-t", paneId, "-l", command);
    tmux("send-keys", "-t", paneId, "Enter");
    return { agent: { name: args[2], pane_id: paneId } };
  }
  if (group === "agent" && verb === "list") {
    return { agents: listAgents(tmux, exec, timeoutMs, readMembers()) };
  }
  throw failure("method_not_found", `tmux backend does not support herdr ${args.join(" ")}.`);
}

function listAgents(
  tmux: (...args: string[]) => string,
  exec: TmuxExec,
  timeoutMs: number,
  members: readonly RoomMember[]
): Record<string, unknown>[] {
  const panes = tmux("list-panes", "-a", "-F", `#{pane_id}${FIELD}#{pane_tty}${FIELD}#{@tt_agent}${FIELD}#{@tt_kind}`)
    .split("\n").filter(Boolean).map((line) => {
      const [paneId, tty, name, kind] = line.split(FIELD);
      return { paneId, tty: bareTty(tty), name: name || null, kind: kind || null };
    });
  const withPid = members.filter((member) => member.harness_pid && member.harness_session_id?.startsWith(HARNESS_SESSION_PREFIX));
  const ttys = new Map<number, string>();
  if (withPid.length > 0) {
    try {
      for (const line of exec("ps", ["-o", "pid=,tty=", "-p", withPid.map((member) => member.harness_pid).join(",")], timeoutMs).split("\n")) {
        const [pid, tty] = line.trim().split(/\s+/);
        if (pid && tty && tty !== "??") ttys.set(Number(pid), bareTty(tty));
      }
    } catch {
      // ps exits non-zero when none of the pids exist.
    }
  }
  return panes.flatMap((pane) => {
    const member = withPid.find((candidate) => ttys.get(candidate.harness_pid!) === pane.tty);
    if (!pane.name && !member) return [];
    return [{
      pane_id: pane.paneId,
      name: pane.name,
      agent: pane.kind ?? (member ? KIND_BY_HARNESS[member.harness_name ?? ""] ?? member.harness_name : null),
      agent_session: member ? { kind: "id", value: member.harness_session_id!.slice(HARNESS_SESSION_PREFIX.length) } : null,
      agent_status: null
    }];
  });
}

// Like Herdr's process-info: the processes in the pane terminal's foreground
// process group.
function foregroundProcesses(exec: TmuxExec, tty: string, timeoutMs: number): Array<{ pid: number; argv0: string }> {
  let output: string;
  try {
    output = exec("ps", ["-t", bareTty(tty), "-o", "pid=,stat=,comm="], timeoutMs);
  } catch {
    return [];
  }
  return output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    return match && match[2].includes("+") ? [{ pid: Number(match[1]), argv0: match[3] }] : [];
  });
}

function bareTty(tty: string): string {
  return tty.replace(/^\/dev\//, "");
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

// Shaped like a failed Herdr call so callers read codes the same way. tmux
// refusals are definite (nothing was done); a timeout leaves the code null.
function tmuxFailure(error: unknown): Error {
  const record = error as { stderr?: unknown; killed?: boolean; signal?: unknown };
  const stderr = typeof record?.stderr === "string" ? record.stderr.trim() : "";
  if (record?.killed || record?.signal || !stderr) {
    return Object.assign(new Error(stderr || (error instanceof Error ? error.message : String(error))), { stderr });
  }
  return failure(/can't find (pane|window|session)/.test(stderr) ? "pane_not_found" : "invalid_params", `tmux: ${stderr}`);
}

function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { stderr: JSON.stringify({ error: { code, message } }) });
}
