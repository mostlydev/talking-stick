import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { HarnessId } from "./harness-model.js";
import {
  listHerdrAgents,
  preferredSplitDirection,
  readPaneLayout,
  type HerdrAgent,
  type HerdrContext,
  type HerdrRunner
} from "./herdr.js";
import {
  findHerdrAgentForMember,
  isLiveMember,
  proveMemberInPane,
  type StartTimeReader
} from "./launch-identity.js";
import type { LaunchRecord } from "./launch-record.js";
import { resolveContextPath } from "./path-resolution.js";
import { resolvePrimarySkillTargetPath } from "./skill-install.js";
import type { RoomMember } from "./types.js";

export type LaunchTopology = "here" | "new-tab" | "new-workspace";
export type LaunchAgent = "claude" | "codex" | "grok";
export type CheckStatus = "ok" | "uncertain" | "failed";

export interface LaunchAdapter {
  herdr_kind: string;
  harness: HarnessId;
  executable: string;
  // Interactive positional prompt accepted after Herdr's `--`.
  initial_prompt: boolean;
  experimental: boolean;
}

// Explicit per-harness adapters; other Herdr kinds are not implied support.
const LAUNCH_ADAPTERS: Record<LaunchAgent, LaunchAdapter> = {
  claude: { herdr_kind: "claude", harness: "claude-code", executable: "claude", initial_prompt: true, experimental: false },
  codex: { herdr_kind: "codex", harness: "codex", executable: "codex", initial_prompt: true, experimental: false },
  grok: { herdr_kind: "grok", harness: "grok", executable: "grok", initial_prompt: true, experimental: true }
};

export const LAUNCH_AGENTS = Object.keys(LAUNCH_ADAPTERS) as LaunchAgent[];

export function launchAdapter(agent: LaunchAgent): LaunchAdapter {
  return LAUNCH_ADAPTERS[agent];
}

const CHAT_MEMBER_PATTERN = /^human:[^:]+:chat:/;

export interface LaunchCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  remedy?: string;
}

export interface LaunchAgentPlan {
  agent: LaunchAgent;
  action: "launch" | "skip" | "inspect";
  reason?: string;
  experimental: boolean;
  herdr_name: string;
  skill_path: string;
  prompt_delivery: "initial_argument" | "agent_prompt";
  prompt: string;
}

export type LaunchStepKind = "anchor" | "chat" | "split" | "start" | "prompt";

// Steps are the single description of a launch: --print renders them and the
// executor runs them, substituting <placeholders> with pane IDs Herdr returns.
export interface LaunchStep {
  kind: LaunchStepKind;
  agent?: LaunchAgent;
  produces?: string;
  description: string;
  argv: string[];
}

export const AGENT_START_TIMEOUT_MS = 60_000;
export const AGENT_PROMPT_TIMEOUT_MS = 120_000;

export interface WorkspaceLaunchPlan {
  status: "ready" | "needs_confirmation" | "blocked";
  canonical_path: string;
  room_id: string | null;
  topology: LaunchTopology;
  herdr: HerdrContext | null;
  checks: LaunchCheck[];
  chat: { action: "launch" | "skip" | "inspect"; reason?: string };
  agents: LaunchAgentPlan[];
  steps: LaunchStep[];
}

export interface PlanWorkspaceLaunchInput {
  agents: LaunchAgent[];
  context_path: string;
  topology: LaunchTopology;
  herdr: HerdrContext | null;
  runner: HerdrRunner;
  room: { room_id: string; members: RoomMember[] } | null;
  readStartTime: StartTimeReader;
  record?: LaunchRecord | null;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export function parseLaunchAgents(value: string | undefined): LaunchAgent[] {
  if (!value) {
    throw new Error(`--agents is required, e.g. --agents claude,codex (supported: ${LAUNCH_AGENTS.join(", ")}).`);
  }
  const agents: LaunchAgent[] = [];
  for (const raw of value.split(",")) {
    const name = raw.trim();
    if (!name) continue;
    if (!(LAUNCH_AGENTS as string[]).includes(name)) {
      throw new Error(`Unsupported agent "${name}". Supported: ${LAUNCH_AGENTS.join(", ")}.`);
    }
    if (agents.includes(name as LaunchAgent)) {
      throw new Error(`Agent "${name}" is listed more than once.`);
    }
    agents.push(name as LaunchAgent);
  }
  if (agents.length === 0) throw new Error("--agents must name at least one agent.");
  return agents;
}

export function buildBootstrapPrompt(skillPath: string, canonicalPath: string): string {
  return [
    `Use the talking-stick skill (${path.join(skillPath, "SKILL.md")}).`,
    `Join the Talking Stick room for ${canonicalPath} with \`tt join --json\` and load \`tt instructions show --json\`.`,
    "You have no task yet: follow the skill's taskless path (`tt standby --json`, or one `tt wait --park --json` if it cannot self-wake).",
    "Do not claim the stick or start work; wait for instructions from the operator in tt chat."
  ].join(" ");
}

// Read-only: inspects Herdr layout, the filesystem, and room membership, then
// describes the side effects a launch would perform. Nothing is created here.
export function planWorkspaceLaunch(input: PlanWorkspaceLaunchInput): WorkspaceLaunchPlan {
  const env = input.env ?? process.env;
  const checks: LaunchCheck[] = [];
  const resolved = resolveContextPath(input.context_path);
  const canonicalPath = resolved.canonical_context_path;

  if (!input.herdr) {
    checks.push({
      name: "herdr",
      status: "failed",
      detail: "Not running inside a Herdr pane (HERDR_ENV=1 and HERDR_PANE_ID are required).",
      remedy: "Run tt up from a shell pane inside Herdr."
    });
  }
  if (input.topology === "new-tab" && input.herdr && !input.herdr.workspace_id) {
    checks.push({ name: "herdr", status: "failed", detail: "HERDR_WORKSPACE_ID is missing, so a tab cannot be created in this workspace." });
  }

  let callerDirection: "right" | "down" = "right";
  let herdrAgents: HerdrAgent[] = [];
  if (input.herdr) {
    try {
      const layout = readPaneLayout(input.runner, input.herdr.pane_id);
      callerDirection = preferredSplitDirection(layout.rect);
      checks.push({ name: "herdr", status: "ok", detail: `Caller pane ${layout.pane_id} is ${layout.rect.width}x${layout.rect.height}.` });
      herdrAgents = listHerdrAgents(input.runner);
    } catch (error) {
      checks.push({ name: "herdr", status: "failed", detail: error instanceof Error ? error.message : String(error) });
    }
  }

  if (!isDirectory(canonicalPath)) {
    checks.push({ name: "path", status: "failed", detail: `${canonicalPath} is not a directory.` });
  } else {
    checks.push({ name: "path", status: "ok", detail: canonicalPath });
  }

  const ttCheck = executableCheck("tt", env);
  if (ttCheck.status === "uncertain") {
    ttCheck.status = "failed";
    ttCheck.detail = "tt is missing from the launcher's PATH; bootstrap commands cannot rely on it.";
    ttCheck.remedy = "Install or link Talking Stick and run this command from a shell where tt is on PATH.";
  }
  checks.push(ttCheck);

  const agents = input.agents.map((agent): LaunchAgentPlan => {
    const adapter = LAUNCH_ADAPTERS[agent];
    const skillPath = resolvePrimarySkillTargetPath(adapter.harness as Exclude<HarnessId, "gemini">, { homeDir: input.homeDir });
    const skillFile = path.join(skillPath, "SKILL.md");
    if (fs.existsSync(skillFile)) {
      checks.push({ name: `${agent} skill`, status: "ok", detail: skillFile });
    } else {
      checks.push({ name: `${agent} skill`, status: "failed", detail: `${skillFile} is missing.`, remedy: `tt install ${adapter.harness}` });
    }
    // Herdr launches inside an interactive pane shell whose PATH may differ
    // from ours, so local absence is uncertainty and agent start decides.
    checks.push(executableCheck(adapter.executable, env));

    const herdrName = herdrAgentName(agent, canonicalPath);
    const decision = decideAgent(agent, adapter, herdrName, input, herdrAgents);
    return {
      agent,
      ...decision,
      experimental: adapter.experimental,
      herdr_name: herdrName,
      skill_path: skillPath,
      prompt_delivery: adapter.initial_prompt ? "initial_argument" : "agent_prompt",
      prompt: buildBootstrapPrompt(skillPath, canonicalPath)
    };
  });

  const chatMember = input.room?.members.find((member) =>
    member.status === "active" && member.session_kind === "human_chat" && CHAT_MEMBER_PATTERN.test(member.agent_id)
  );
  const chat: WorkspaceLaunchPlan["chat"] = chatMember
    ? chatMember.process_liveness === "alive"
      ? { action: "skip", reason: `${chatMember.agent_id} is a live chat console in this room.` }
      : { action: "inspect", reason: `${chatMember.agent_id} has unconfirmed console liveness.` }
    : { action: "launch" };
  const steps = input.herdr
    ? planSteps(input.topology, input.herdr, canonicalPath, callerDirection, chat.action === "launch", agents)
    : [];

  return {
    status: checks.some((check) => check.status === "failed") ? "blocked"
      : chat.action === "inspect" || agents.some((agent) => agent.action === "inspect") ? "needs_confirmation" : "ready",
    canonical_path: canonicalPath,
    room_id: input.room?.room_id ?? null,
    topology: input.topology,
    herdr: input.herdr,
    checks,
    chat,
    agents,
    steps
  };
}

// Launch only when nothing live could already be this agent. Anything that
// might be ours but cannot be proven is surfaced, never relaunched over.
function decideAgent(
  agent: LaunchAgent,
  adapter: LaunchAdapter,
  herdrName: string,
  input: PlanWorkspaceLaunchInput,
  herdrAgents: HerdrAgent[]
): { action: LaunchAgentPlan["action"]; reason?: string } {
  const deps = { runner: input.runner, readStartTime: input.readStartTime };
  const candidates = (input.room?.members ?? []).filter((member) => isLiveMember(member, agent));
  let unproven: string | null = null;
  for (const member of candidates) {
    const herdrAgent = findHerdrAgentForMember(member, herdrAgents);
    if (!herdrAgent) {
      unproven ??= `${member.agent_id} is active in this room but no Herdr pane reports its session.`;
      continue;
    }
    const proof = proveMemberInPane(member, herdrAgent, adapter.executable, deps);
    if (proof.confirmed) return { action: "skip", reason: proof.reason };
    unproven ??= proof.reason;
  }
  if (unproven) return { action: "inspect", reason: unproven };

  const previous = input.record?.agents[agent];
  if (previous?.pane_id && previous.state !== "failed" &&
      herdrAgents.some((candidate) => candidate.pane_id === previous.pane_id)) {
    return { action: "inspect", reason: `An earlier launch left ${agent} in pane ${previous.pane_id} (${previous.state}) without a confirmed join.` };
  }
  const clash = herdrAgents.find((candidate) => candidate.name === herdrName);
  if (clash) {
    return { action: "inspect", reason: `Herdr name ${herdrName} is already used by pane ${clash.pane_id}.` };
  }
  return { action: "launch" };
}

function planSteps(
  topology: LaunchTopology,
  herdr: HerdrContext,
  canonicalPath: string,
  callerDirection: "right" | "down",
  openChat: boolean,
  agents: LaunchAgentPlan[]
): LaunchStep[] {
  const steps: LaunchStep[] = [];
  const launching = agents.filter((agent) => agent.action === "launch");
  if (!openChat && launching.length === 0) return steps;
  // Without a new chat console, the first agent takes the anchor pane instead.
  const anchorPane = openChat ? "<chat-pane>" : "<anchor-pane>";
  // Agents stack perpendicular to the chat split so columns stay usable.
  let agentDirection: "right" | "down" = "right";
  if (topology === "new-workspace") {
    steps.push({
      kind: "anchor",
      produces: anchorPane,
      description: `Create a workspace; its root pane (${anchorPane}) anchors the layout.`,
      argv: ["herdr", "workspace", "create", "--cwd", canonicalPath, "--label", path.basename(canonicalPath), "--no-focus"]
    });
  } else if (topology === "new-tab") {
    steps.push({
      kind: "anchor",
      produces: anchorPane,
      description: `Create a tab in the caller's workspace; its root pane (${anchorPane}) anchors the layout.`,
      argv: ["herdr", "tab", "create", "--workspace", herdr.workspace_id ?? "<workspace>", "--cwd", canonicalPath, "--label", "talking-stick", "--no-focus"]
    });
  } else {
    steps.push({
      kind: "anchor",
      produces: anchorPane,
      description: `Split the caller pane for ${anchorPane}, keeping focus.`,
      argv: ["herdr", "pane", "split", "--pane", herdr.pane_id, "--direction", callerDirection, "--cwd", canonicalPath, "--no-focus"]
    });
    agentDirection = callerDirection === "right" ? "down" : "right";
  }
  if (openChat) {
    steps.push({ kind: "chat", description: "Open the operator chat console.", argv: ["herdr", "pane", "run", anchorPane, "tt chat"] });
  }

  let previous = anchorPane;
  let first = true;
  for (const agent of launching) {
    // The anchor is already a fresh shell when no chat console occupies it.
    const reuseAnchor = first && !openChat;
    const pane = reuseAnchor ? anchorPane : `<${agent.agent}-pane>`;
    // In a fresh tab the first agent sits beside chat; the rest stack below it.
    const direction = topology === "here" ? agentDirection : first ? "right" : "down";
    if (!reuseAnchor) {
      steps.push({
        kind: "split",
        agent: agent.agent,
        produces: pane,
        description: `Create a fresh shell pane for ${agent.agent}.`,
        argv: ["herdr", "pane", "split", "--pane", previous, "--direction", direction, "--cwd", canonicalPath, "--no-focus"]
      });
    }
    const start = [
      "herdr", "agent", "start", agent.herdr_name, "--kind", LAUNCH_ADAPTERS[agent.agent].herdr_kind,
      "--pane", pane, "--timeout", String(AGENT_START_TIMEOUT_MS)
    ];
    if (agent.prompt_delivery === "initial_argument") {
      steps.push({ kind: "start", agent: agent.agent, description: `Start ${agent.agent} with the bootstrap prompt.`, argv: [...start, "--", agent.prompt] });
    } else {
      steps.push({ kind: "start", agent: agent.agent, description: `Start ${agent.agent}.`, argv: start });
      steps.push({
        kind: "prompt",
        agent: agent.agent,
        description: `Submit the bootstrap prompt to ${agent.agent} once ready.`,
        argv: ["herdr", "agent", "prompt", agent.herdr_name, agent.prompt, "--wait", "--timeout", String(AGENT_PROMPT_TIMEOUT_MS)]
      });
    }
    previous = pane;
    first = false;
  }
  return steps;
}

function herdrAgentName(agent: LaunchAgent, canonicalPath: string): string {
  const base = path.basename(canonicalPath).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "");
  const hash = createHash("sha256").update(canonicalPath).digest("hex").slice(0, 8);
  return `${agent}-${base || "room"}`.slice(0, 23).replace(/-+$/, "") + `-${hash}`;
}

function executableCheck(name: string, env: NodeJS.ProcessEnv): LaunchCheck {
  const found = findOnPath(name, env.PATH ?? "");
  return found
    ? { name: `${name} executable`, status: "ok", detail: found }
    : { name: `${name} executable`, status: "uncertain", detail: `${name} is not on this process's PATH; the pane shell may still resolve it.` };
}

function findOnPath(name: string, searchPath: string): string | null {
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here; keep searching.
    }
  }
  return null;
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}
