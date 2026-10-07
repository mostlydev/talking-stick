import { resolveDataDir } from "../config.js";
import { createSystemHerdrRunner, readHerdrContext, type HerdrRunner } from "../herdr.js";
import { createSystemStartTimeReader, type StartTimeReader } from "../launch-identity.js";
import { acquireLaunchLock, readLaunchRecord, launchRecordPath } from "../launch-record.js";
import fs from "node:fs";
import { resolveContextPath } from "../path-resolution.js";
import {
  DEFAULT_JOIN_TIMEOUT_MS,
  executeWorkspaceLaunch,
  type WorkspaceLaunchResult
} from "../workspace-launch-run.js";
import {
  parseLaunchAgents,
  planWorkspaceLaunch,
  type LaunchTopology,
  type WorkspaceLaunchPlan
} from "../workspace-launch.js";
import { deriveCliIdentity } from "./identity.js";
import { printResult } from "./output.js";
import { getStringOption, hasOption, parseWaitTimeout, type ParsedCommand } from "./parser.js";
import type { Runtime } from "./runtime.js";
import { pickDeepestRoom } from "./session.js";

export const UP_USAGE =
  "tt up --agents claude,codex[,grok] [--path DIR] [--new-tab | --new-workspace] [--print] [--forget] [--timeout 120s] [--json]";

export interface UpCommandOptions {
  env?: NodeJS.ProcessEnv;
  runner?: HerdrRunner;
  readStartTime?: StartTimeReader;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  homeDir?: string;
}

export async function handleUpCommand(
  runtime: Runtime,
  parsed: ParsedCommand,
  options: UpCommandOptions = {}
): Promise<void> {
  const env = options.env ?? process.env;
  const agents = parseLaunchAgents(getStringOption(parsed, "agents"));
  const topology = parseTopology(parsed);
  const joinTimeoutMs = parseWaitTimeout(parsed) ?? DEFAULT_JOIN_TIMEOUT_MS;
  const contextPath = getStringOption(parsed, "path") ?? process.cwd();
  const resolved = resolveContextPath(contextPath);
  const canonicalPath = resolved.canonical_context_path;
  const selectedRoom = pickDeepestRoom(runtime.commands.listRooms({ context_path: canonicalPath }).rooms);
  const joinPath = selectedRoom?.canonical_path ?? resolved.workspace_root;
  if (joinPath !== canonicalPath) {
    throw new Error(`Ordinary tt join/chat would select room ${joinPath}, not ${canonicalPath}. Use --path ${joinPath} for this launcher, or explicitly create a nested room first.`);
  }
  const runner = options.runner ?? createSystemHerdrRunner(env);
  const readStartTime = options.readStartTime ?? createSystemStartTimeReader();
  const dataDir = resolveDataDir({ env });
  const preview = hasOption(parsed, "print");

  // A preview takes no lock; a launch plans under the lock so a concurrent
  // launcher cannot act on the same stale view of the room and record.
  const release = preview ? () => {} : acquireLaunchLock(dataDir, canonicalPath);
  try {
    const forget = hasOption(parsed, "forget");
    const record = forget ? null : readLaunchRecord(dataDir, canonicalPath);
    const plan = planWorkspaceLaunch({
      agents,
      context_path: contextPath,
      topology,
      herdr: readHerdrContext(env),
      runner,
      room: findExactRoom(runtime, parsed, canonicalPath),
      readStartTime,
      record,
      env,
      homeDir: options.homeDir
    });
    if (preview) {
      printResult(parsed, plan, () => renderPlan(plan));
      if (plan.status !== "ready") process.exitCode = 1;
      return;
    }
    if (forget && plan.status !== "blocked") {
      fs.rmSync(launchRecordPath(dataDir, canonicalPath), { force: true });
    }
    const result = await executeWorkspaceLaunch(plan, {
      runner,
      readStartTime,
      readMembers: () => findExactRoom(runtime, parsed, canonicalPath)?.members ?? null,
      dataDir,
      record,
      joinTimeoutMs,
      sleep: options.sleep,
      now: options.now
    });
    printResult(parsed, result, () => renderResult(plan, result));
    if (result.status !== "launched" && result.status !== "nothing_to_do") process.exitCode = 1;
  } finally {
    release();
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

// Only the room for this exact path counts; a parent room is a different room.
function findExactRoom(runtime: Runtime, parsed: ParsedCommand, canonicalPath: string) {
  const rooms = runtime.commands.listRooms({ context_path: canonicalPath }).rooms;
  const room = pickDeepestRoom(rooms.filter((candidate) => candidate.canonical_path === canonicalPath));
  if (!room) return null;
  const identity = deriveCliIdentity(parsed);
  const state = runtime.commands.getRoomState({ room_id: room.room_id, agent_id: identity.agent_id });
  return { room_id: room.room_id, members: state.members };
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
  lines.push("", `Chat console: ${plan.chat.action}${plan.chat.reason ? ` — ${plan.chat.reason}` : ""}`, "", "Agents:");
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
    lines.push("", "Steps (nothing has been run):");
    plan.steps.forEach((step, index) => {
      lines.push(`  ${index + 1}. ${step.description}`, `     ${step.argv.map(shellQuote).join(" ")}`);
    });
  }
  return lines.join("\n");
}

export function renderResult(plan: WorkspaceLaunchPlan, result: WorkspaceLaunchResult): string {
  const lines = [`Launch for ${result.canonical_path} (${plan.topology}) — ${result.status}`, ""];
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
