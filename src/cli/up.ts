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
  parseLaunchAgents,
  installedLaunchAgents,
  planWorkspaceLaunch,
  type LaunchTopology,
  type WorkspaceLaunchPlan
} from "../workspace-launch.js";
import { deriveCliIdentity, isKnownHarnessCliEnv } from "./identity.js";
import { printResult, shouldUseJson } from "./output.js";
import { getStringOption, hasOption, parseCommand, parseWaitTimeout, type ParsedCommand } from "./parser.js";
import type { Runtime } from "./runtime.js";
import { RoomSelectorError, selectedRoom } from "./room-selector.js";
import { pickDeepestRoom } from "./session.js";

export const UP_USAGE =
  "tt up [--agents claude,codex,grok,opencode,antigravity] [--path DIR] [--new-tab | --new-workspace] [--print] [--forget] [--timeout 120s] [--json]";

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
}

export async function handleUpCommand(
  runtime: Runtime,
  parsed: ParsedCommand,
  options: UpCommandOptions = {}
): Promise<void> {
  const env = options.env ?? process.env;
  const requestedAgents = getStringOption(parsed, "agents");
  const agents = requestedAgents === undefined
    ? installedLaunchAgents(env, options.homeDir)
    : parseLaunchAgents(requestedAgents);
  if (agents.length === 0) {
    throw new Error("No default chat agents with both an executable on PATH and an installed Talking Stick skill were found. Install Claude, Codex, or Antigravity, or use --agents for an optional launcher.");
  }
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
  // tmux reports agents by matching panes against this room's members.
  let membersRoomId: string | null = resolvedRoom?.room_id ?? null;
  const panes = openPaneSession(env, {
    runner: options.runner,
    readMembers: () => roomWithMembers(runtime, parsed, membersRoomId)?.members ?? []
  });
  const runner = panes.runner;
  const readStartTime = options.readStartTime ?? createSystemStartTimeReader();
  const dataDir = resolveDataDir({ env });

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
      if (requestedAgents === undefined) {
        const optional = installedLaunchAgents(env, options.homeDir, true).filter((agent) => !agents.includes(agent));
        if (optional.length > 0) {
          plan.checks.push({ name: "optional launchers", status: "uncertain", detail: `${optional.join(", ")} are installed but require explicit --agents.` });
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
    if (result.chat.state === "ready" && targetRoomId) {
      const canAttachChat = !hasOption(parsed, "json") && !isKnownHarnessCliEnv(env) &&
        chatTerminalCapable({ isTTY: options.stdinIsTTY ?? process.stdin.isTTY },
          { isTTY: options.stdoutIsTTY ?? process.stdout.isTTY }, env);
      if (!canAttachChat) {
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
