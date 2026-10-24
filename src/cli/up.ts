import { resolveDataDir } from "../config.js";
import type { HerdrRunner } from "../herdr.js";
import { createSystemStartTimeReader, type StartTimeReader } from "../launch-identity.js";
import { acquireLaunchLock, readLaunchRecord, launchRecordPath } from "../launch-record.js";
import { openPaneSession } from "../pane-backend.js";
import fs from "node:fs";
import { chatTerminalCapable, handleChatCommand } from "./chat.js";
import { resolveContextPath } from "../path-resolution.js";
import {
  DEFAULT_JOIN_TIMEOUT_MS,
  executeWorkspaceLaunch,
  type WorkspaceLaunchResult
} from "../workspace-launch-run.js";
import {
  LAUNCH_AGENTS,
  parseLaunchAgents,
  installedLaunchAgents,
  launchUnavailableReason,
  planWorkspaceLaunch,
  type LaunchAgent,
  type LaunchTopology,
  type WorkspaceLaunchPlan
} from "../workspace-launch.js";
import {
  DEFAULT_AGENT_PAIR,
  launchDefaultsPath,
  readLaunchDefaults,
  resolveAgentChoice,
  saveAgentChoice,
  savedAgents,
  type AgentChoiceSource
} from "../launch-defaults.js";
import { AgentPicker, runAgentPicker, type PickerScope } from "./agent-picker.js";
import { deriveCliIdentity, isKnownHarnessCliEnv } from "./identity.js";
import { printResult, shouldUseJson } from "./output.js";
import { getStringOption, hasOption, parseCommand, parseWaitTimeout, type ParsedCommand } from "./parser.js";
import type { Runtime } from "./runtime.js";
import { RoomSelectorError, roomShortName, selectedRoom } from "./room-selector.js";
import { pickDeepestRoom } from "./session.js";

export const UP_USAGE =
  "tt up [--agents claude,codex,grok,opencode,antigravity [--save [--room]] | --choose] [--path DIR] [--new-tab | --new-workspace] [--print] [--forget] [--timeout 120s] [--json]";

export type AgentPickerPrompt = (picker: AgentPicker, roomName: string) =>
  Promise<{ agents: LaunchAgent[]; scope: PickerScope } | null>;

export interface UpCommandOptions {
  env?: NodeJS.ProcessEnv;
  runner?: HerdrRunner;
  readStartTime?: StartTimeReader;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  homeDir?: string;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  startLocalChat?: (runtime: Runtime, contextPath: string, roomId: string) => Promise<void>;
  pickAgents?: AgentPickerPrompt;
}

const pickAgentsInTerminal: AgentPickerPrompt = (picker, roomName) =>
  runAgentPicker(picker, roomName, { input: process.stdin, output: process.stdout, env: process.env });

function describeChoice(source: AgentChoiceSource, dataDir: string): string {
  if (source === "flag") return "--agents";
  if (source === "pair") return "default pair; tt up --choose saves another";
  return `${source === "room" ? "saved for this room" : "saved default"}, ${launchDefaultsPath(dataDir)}`;
}

export async function handleUpCommand(
  runtime: Runtime,
  parsed: ParsedCommand,
  options: UpCommandOptions = {}
): Promise<void> {
  const env = options.env ?? process.env;
  const requestedAgents = getStringOption(parsed, "agents");
  const requested = requestedAgents === undefined ? undefined : parseLaunchAgents(requestedAgents);
  const choose = hasOption(parsed, "choose");
  const save = hasOption(parsed, "save");
  const json = hasOption(parsed, "json");
  if (choose && requested) throw new Error("--choose and --agents are mutually exclusive.");
  if (save && !requested) throw new Error("--save stores the agents named with --agents, e.g. tt up --agents claude,codex --save.");
  if (hasOption(parsed, "room") && !save) throw new Error("--room only applies with --save.");
  if ((choose || save) && hasOption(parsed, "print")) throw new Error("--print changes nothing; drop --choose or --save.");
  const topology = parseTopology(parsed);
  const joinTimeoutMs = parseWaitTimeout(parsed) ?? DEFAULT_JOIN_TIMEOUT_MS;
  const contextPath = getStringOption(parsed, "path") ?? process.cwd();
  const resolved = resolveContextPath(contextPath);
  const canonicalPath = resolved.canonical_context_path;
  const preview = hasOption(parsed, "print");
  // Panes start in the caller's directory; the room is chosen separately and
  // pinned by id, so a linked worktree or a subdirectory launches into the
  // room an ordinary join from here would use (or the one named with --in).
  let pinnedRoom: ReturnType<typeof selectedRoom> = null;
  let ignoredPin = false;
  try {
    pinnedRoom = selectedRoom(runtime, parsed, env);
  } catch (error) {
    // A closed/deleted room pin is inherited by panes from an earlier launch.
    // Only that missing inherited selection may recover via the current path.
    if (getStringOption(parsed, "in") !== undefined ||
        !(error instanceof RoomSelectorError) || error.reason !== "not_found") throw error;
    ignoredPin = true;
  }
  const pinWarning = {
    name: "inherited room pin", status: "uncertain" as const,
    detail: "Ignored TT_ROOM because it names no open room; using the launch directory.",
    remedy: "Clear TT_ROOM in this pane before using other room commands."
  };
  const resolvedRoom = pinnedRoom ??
    pickDeepestRoom(runtime.commands.listRooms({ context_path: canonicalPath }).rooms);
  // Lock and record follow the room, not the cwd, so two worktrees launching
  // into one room serialize. A room opened below keeps this same path.
  const roomKey = resolvedRoom?.canonical_path ?? resolved.room_path;
  const dataDir = resolveDataDir({ env });
  // One gate for "a person is at this terminal", shared with attaching chat. A
  // harness marker withholds the automatic picker, since a prompt would hang
  // an agent's tool call, but never an explicit --choose.
  const terminal = chatTerminalCapable({ isTTY: options.stdinIsTTY ?? process.stdin.isTTY },
    { isTTY: options.stdoutIsTTY ?? process.stdout.isTTY }, env) && !json;
  const harnessShell = isKnownHarnessCliEnv(env);
  if (choose && !terminal) throw new Error("--choose needs an interactive terminal; use tt up --agents claude,codex --save instead.");
  const launchable = installedLaunchAgents(env, options.homeDir, true);
  const defaults = requested ? {} : readLaunchDefaults(dataDir);
  if (save) saveAgentChoice(dataDir, requested!, roomKey, hasOption(parsed, "room") ? "room" : "every");
  let choice = resolveAgentChoice({ requested, defaults, roomKey, launchable });
  const worthAsking = launchable.length > 1 || launchable.some((agent) => !DEFAULT_AGENT_PAIR.includes(agent));
  const unsaved = !requested && savedAgents(defaults, roomKey) === null;
  // A saved agent that can no longer start asks again too, rather than
  // quietly launching whoever is left.
  const ask = (unsaved && worthAsking) || choice.unavailable.length > 0;
  if (choose || (ask && terminal && !harnessShell && !hasOption(parsed, "print"))) {
    const rows = LAUNCH_AGENTS.map((agent) => ({
      agent,
      unavailable: choice.unavailable.includes(agent) ? "saved but not installed"
        : launchUnavailableReason(agent, env, options.homeDir) ?? undefined
    }));
    const picked = await (options.pickAgents ?? pickAgentsInTerminal)(
      new AgentPicker(rows, choice.agents, choice.source === "room" ? "room" : "every"), roomShortName({ canonical_path: roomKey }));
    if (!picked) {
      process.stderr.write("[tt up] Cancelled; nothing was launched or saved.\n");
      process.exitCode = 130;
      return;
    }
    saveAgentChoice(dataDir, picked.agents, roomKey, picked.scope);
    process.stderr.write(`[tt up] Saved ${picked.agents.join(", ")} for ${picked.scope === "room" ? "this room" : "every room"}. Change it with tt up --choose.\n`);
    choice = { agents: picked.agents, source: picked.scope === "room" ? "room" : "default", unavailable: [] };
  } else if (ask && terminal && harnessShell && !hasOption(parsed, "print")) {
    process.stderr.write("[tt up] Not asking which agents to start: this shell looks like an agent's (tt whoami --explain shows why). Run tt up --choose to pick.\n");
  }
  const agents = choice.agents;
  if (agents.length === 0) {
    throw new Error(choice.source === "pair"
      ? "Neither Claude nor Codex has an executable on PATH and an installed Talking Stick skill. Install one, or name agents with --agents."
      : `None of the saved agents (${choice.unavailable.join(", ")}) can start here. Run tt up --choose, or tt up --agents claude,codex --save.`);
  }
  // tmux reports agents by matching panes against this room's members.
  let membersRoomId: string | null = resolvedRoom?.room_id ?? null;
  const panes = openPaneSession(env, {
    runner: options.runner,
    readMembers: () => roomWithMembers(runtime, parsed, membersRoomId)?.members ?? []
  });
  const runner = panes.runner;
  const readStartTime = options.readStartTime ?? createSystemStartTimeReader();

  // A preview takes no lock; a launch plans under the lock so a concurrent
  // launcher cannot act on the same stale view of the room and record.
  const release = preview ? () => {} : acquireLaunchLock(dataDir, roomKey);
  let localChatRoomId: string | null = null;
  try {
    const forget = hasOption(parsed, "forget");
    const record = forget ? null : readLaunchRecord(dataDir, roomKey);
    const planFor = (roomId: string | null) => {
      membersRoomId = roomId;
      const plan = planWorkspaceLaunch({
        agents,
        context_path: contextPath,
        topology,
        herdr: panes.context,
        backend: panes.backend,
        runner,
        room: roomWithMembers(runtime, parsed, roomId),
        pin_room_id: roomId,
        readStartTime,
        record,
        env,
        homeDir: options.homeDir
      });
      if (ignoredPin) plan.checks.push(pinWarning);
      plan.checks.push({ name: "agent choice", status: "ok", detail: `${agents.join(", ")} (${describeChoice(choice.source, dataDir)})` });
      if (choice.unavailable.length > 0) {
        plan.checks.push({ name: "saved agents", status: "uncertain",
          detail: `${choice.unavailable.join(", ")} ${choice.unavailable.length === 1 ? "is" : "are"} saved but cannot start here.`,
          remedy: "tt up --choose" });
      }
      if (requestedAgents === undefined) {
        const optional = launchable.filter((agent) => !agents.includes(agent));
        if (optional.length > 0) {
          plan.checks.push({ name: "other launchers", status: "uncertain", detail: `${optional.join(", ")} ${optional.length === 1 ? "is" : "are"} installed but not chosen; tt up --choose or --agents adds them.` });
        }
      }
      return plan;
    };
    let targetRoomId = resolvedRoom?.room_id ?? null;
    let plan = planFor(targetRoomId);
    // A room that does not exist yet is opened only under the lock, after the
    // plan passes preflight, so a blocked launch never leaves an empty room.
    if (!preview && !targetRoomId && plan.status === "ready") {
      targetRoomId = runtime.commands.openRoom({ context_path: canonicalPath }).room_id;
      plan = planFor(targetRoomId);
    }
    if (preview) {
      printResult(parsed, plan, () => renderPlan(plan));
      if (plan.status !== "ready") process.exitCode = 1;
      return;
    }
    if (forget && plan.status !== "blocked") {
      fs.rmSync(launchRecordPath(dataDir, roomKey), { force: true });
    }
    if (ignoredPin && !shouldUseJson(parsed)) {
      process.stderr.write(`[tt up] ${pinWarning.detail} ${pinWarning.remedy}\n`);
    }
    const skipped = choice.unavailable.length > 0
      ? `Skipped ${choice.unavailable.join(", ")}: saved but cannot start here. Run tt up --choose to change the saved agents.`
      : null;
    if (skipped && !shouldUseJson(parsed)) process.stderr.write(`[tt up] ${skipped}\n`);
    const result = await executeWorkspaceLaunch(plan, {
      runner,
      readStartTime,
      readMembers: () => roomWithMembers(runtime, parsed, targetRoomId)?.members ?? null,
      dataDir,
      record,
      joinTimeoutMs,
      sleep: options.sleep,
      now: options.now,
      onProgress: (message) => { process.stderr.write(`[tt up] ${message}\n`); }
    });
    if (ignoredPin && shouldUseJson(parsed)) result.next_steps.unshift(`${pinWarning.detail} ${pinWarning.remedy}`);
    if (skipped && shouldUseJson(parsed)) result.next_steps.unshift(skipped);
    if (result.chat.state === "ready" && targetRoomId) {
      if (!terminal || harnessShell) {
        result.next_steps.push(`Run tt chat --in ${targetRoomId} in this pane to open the console.`);
      } else {
        localChatRoomId = targetRoomId;
      }
    }
    printResult(parsed, result, () => renderResult(plan, result));
    if (result.status !== "launched" && result.status !== "nothing_to_do") process.exitCode = 1;
  } finally {
    release();
  }
  // The invoking pane becomes chat only after the launch lock has been
  // released. This same process stays attached to the caller's terminal.
  if (localChatRoomId) {
    if (options.startLocalChat) await options.startLocalChat(runtime, contextPath, localChatRoomId);
    else await handleChatCommand(runtime, parseCommand(["chat", contextPath, "--in", localChatRoomId]));
  }
}

function parseTopology(parsed: ParsedCommand): LaunchTopology {
  const newTab = hasOption(parsed, "new-tab");
  const newWorkspace = hasOption(parsed, "new-workspace");
  if (newTab && newWorkspace) {
    throw new Error("--new-tab and --new-workspace are mutually exclusive.");
  }
  return newWorkspace ? "new-workspace" : newTab ? "new-tab" : "here";
}

// Membership of the pinned room only; another room is a different room.
function roomWithMembers(runtime: Runtime, parsed: ParsedCommand, roomId: string | null) {
  if (!roomId) return null;
  const identity = deriveCliIdentity(parsed);
  const state = runtime.commands.getRoomState({ room_id: roomId, agent_id: identity.agent_id });
  return { room_id: roomId, members: state.members };
}

export function renderPlan(plan: WorkspaceLaunchPlan): string {
  const lines = [
    `Launch preview for ${plan.canonical_path} (${plan.topology}) — ${plan.status}`,
    "",
    "Checks:"
  ];
  for (const check of plan.checks) {
    const remedy = check.remedy ? ` (fix: ${check.remedy})` : "";
    lines.push(`  ${check.status.padEnd(9)} ${check.name}: ${check.detail}${remedy}`);
  }
  lines.push("", `Chat console: ${plan.chat.action}${plan.topology === "here" && plan.chat.action === "launch" ? " in the caller pane after agent startup" : plan.chat.reason ? ` — ${plan.chat.reason}` : ""}`, "", "Agents:");
  for (const agent of plan.agents) {
    const experimental = agent.experimental ? " [experimental]" : "";
    const outcome = agent.action === "launch"
      ? `launch as ${agent.herdr_name} (prompt via ${agent.prompt_delivery.replace("_", " ")})`
      : `${agent.action} — ${agent.reason}`;
    lines.push(`  ${agent.agent}${experimental}: ${outcome}`);
  }
  if (plan.status === "ready" && plan.steps.length === 0) {
    lines.push("", "Nothing to launch: every requested agent and the chat console are already in this room.");
  }
  if (plan.steps.length > 0) {
    lines.push("", plan.backend === "tmux"
      ? "Steps (nothing has been run; tt performs each Herdr verb with tmux):"
      : "Steps (nothing has been run):");
    plan.steps.forEach((step, index) => {
      lines.push(`  ${index + 1}. ${step.description}`, `     ${step.argv.map(shellQuote).join(" ")}`);
    });
  }
  return lines.join("\n");
}

export function renderResult(plan: WorkspaceLaunchPlan, result: WorkspaceLaunchResult): string {
  const lines = [`Launch for ${result.canonical_path} (${plan.topology}) — ${result.status}`, ""];
  if (result.destination) {
    const destination = result.destination;
    lines.push(`Destination: ${destination.workspace_id ?? "workspace"}, ${destination.tab_id ?? "tab"}${destination.tab_number !== null ? ` (tab ${destination.tab_number})` : ""}, label ${destination.label}${destination.focused ? " — shown" : " — select manually"}`, "");
  }
  if (result.status === "blocked") {
    for (const check of plan.checks.filter((candidate) => candidate.status === "failed")) {
      lines.push(`  failed    ${check.name}: ${check.detail}${check.remedy ? ` (fix: ${check.remedy})` : ""}`);
    }
  }
  const chatPane = result.chat.pane_id ? ` (${result.chat.pane_id})` : "";
  lines.push(`Chat console: ${result.chat.state}${chatPane}${result.chat.detail ? ` — ${result.chat.detail}` : ""}`);
  for (const agent of result.agents) {
    const pane = agent.pane_id ? ` (${agent.pane_id})` : "";
    const member = agent.member_id ? ` as ${agent.member_id}` : "";
    lines.push(`  ${agent.agent}: ${agent.state}${pane}${member}${agent.detail ? ` — ${agent.detail}` : ""}`);
  }
  if (result.next_steps.length > 0) {
    lines.push("", "Next:", ...result.next_steps.map((step) => `  - ${step}`));
  }
  return lines.join("\n");
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
