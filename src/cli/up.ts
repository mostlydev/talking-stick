import { createSystemHerdrRunner, readHerdrContext, type HerdrRunner } from "../herdr.js";
import { resolveContextPath } from "../path-resolution.js";
import {
  parseLaunchAgents,
  planWorkspaceLaunch,
  type LaunchTopology,
  type WorkspaceLaunchPlan
} from "../workspace-launch.js";
import { deriveCliIdentity } from "./identity.js";
import { printResult } from "./output.js";
import { getStringOption, hasOption, type ParsedCommand } from "./parser.js";
import type { Runtime } from "./runtime.js";
import { pickDeepestRoom } from "./session.js";

export const UP_USAGE =
  "tt up --agents claude,codex[,grok] [--path DIR] [--new-tab | --new-workspace] --print [--json]";

export interface UpCommandOptions {
  env?: NodeJS.ProcessEnv;
  runner?: HerdrRunner;
}

export function handleUpCommand(
  runtime: Runtime,
  parsed: ParsedCommand,
  options: UpCommandOptions = {}
): void {
  const env = options.env ?? process.env;
  const agents = parseLaunchAgents(getStringOption(parsed, "agents"));
  const topology = parseTopology(parsed);
  if (!hasOption(parsed, "print")) {
    // Launching lands in a later slice; previewing must never create panes.
    throw new Error("tt up currently supports only --print (a read-only launch preview).");
  }

  const contextPath = getStringOption(parsed, "path") ?? process.cwd();
  const canonicalPath = resolveContextPath(contextPath).canonical_context_path;
  const room = findExactRoom(runtime, parsed, canonicalPath);
  const plan = planWorkspaceLaunch({
    agents,
    context_path: contextPath,
    topology,
    herdr: readHerdrContext(env),
    runner: options.runner ?? createSystemHerdrRunner(env),
    room,
    env
  });

  printResult(parsed, plan, () => renderPlan(plan));
  if (plan.status === "blocked") process.exitCode = 1;
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

function renderPlan(plan: WorkspaceLaunchPlan): string {
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
    const outcome = agent.action === "skip"
      ? `skip — ${agent.reason}`
      : `launch as ${agent.herdr_name} (prompt via ${agent.prompt_delivery.replace("_", " ")})`;
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

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
