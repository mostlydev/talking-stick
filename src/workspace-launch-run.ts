import {
  createdPaneId,
  HerdrError,
  listHerdrAgents,
  readPaneProcesses,
  runHerdrJson,
  type HerdrRunner
} from "./herdr.js";
import {
  isLiveMember,
  proveMemberInPane,
  type StartTimeReader
} from "./launch-identity.js";
import {
  writeLaunchRecord,
  type LaunchAgentState,
  type LaunchRecord
} from "./launch-record.js";
import type { RoomMember } from "./types.js";
import {
  AGENT_PROMPT_TIMEOUT_MS,
  AGENT_START_TIMEOUT_MS,
  launchAdapter,
  type LaunchAgent,
  type LaunchStep,
  type WorkspaceLaunchPlan
} from "./workspace-launch.js";

export const DEFAULT_JOIN_TIMEOUT_MS = 120_000;
const JOIN_POLL_MS = 2_000;
// Herdr's own --timeout bounds the call; leave headroom before we give up on it.
const CALL_HEADROOM_MS = 15_000;

export interface ExecuteLaunchDeps {
  runner: HerdrRunner;
  readStartTime: StartTimeReader;
  // Reads the exact room's members; null while no room exists yet.
  readMembers: () => RoomMember[] | null;
  dataDir: string;
  record: LaunchRecord | null;
  joinTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onProgress?: (message: string) => void;
}

export type LaunchOutcomeState = LaunchAgentState | "skipped" | "inspect" | "not_started";

export interface LaunchAgentOutcome {
  agent: LaunchAgent;
  state: LaunchOutcomeState;
  pane_id: string | null;
  detail: string;
  member_id?: string;
}

export interface WorkspaceLaunchResult {
  status: "launched" | "partial" | "nothing_to_do" | "blocked";
  canonical_path: string;
  chat: { state: "opened" | "submitted" | "skipped" | "inspect" | "failed" | "ambiguous" | "not_started"; pane_id: string | null; detail: string };
  agents: LaunchAgentOutcome[];
  next_steps: string[];
  destination: { workspace_id: string | null; tab_id: string | null; tab_number: number | null; label: string; focused: boolean; focus_error?: string } | null;
}

// Runs the plan's steps in order. Each external side effect is recorded before
// and after it happens, and nothing is retried after an uncertain result.
export async function executeWorkspaceLaunch(
  plan: WorkspaceLaunchPlan,
  deps: ExecuteLaunchDeps
): Promise<WorkspaceLaunchResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const progress = deps.onProgress ?? (() => {});
  const outcomes = new Map<LaunchAgent, LaunchAgentOutcome>(plan.agents.map((agent) => [agent.agent, {
    agent: agent.agent,
    state: agent.action === "launch" ? "not_started" : agent.action === "skip" ? "skipped" : "inspect",
    pane_id: null,
    detail: agent.reason ?? ""
  }]));
  const chat: WorkspaceLaunchResult["chat"] = {
    state: plan.chat.action === "launch" ? "not_started" : plan.chat.action === "skip" ? "skipped" : "inspect",
    pane_id: null,
    detail: plan.chat.reason ?? ""
  };
  let destination: WorkspaceLaunchResult["destination"] = null;
  const finish = (status: WorkspaceLaunchResult["status"]): WorkspaceLaunchResult => ({
    status,
    canonical_path: plan.canonical_path,
    chat,
    agents: [...outcomes.values()],
    next_steps: [...nextSteps(plan, chat, [...outcomes.values()]),
      ...(destination?.focus_error ? [`Select the created ${destination.tab_id ?? destination.workspace_id ?? "tab/workspace"} manually: ${destination.focus_error}`] : [])],
    destination
  });

  if (plan.status === "blocked") return finish("blocked");
  if (plan.steps.length === 0) {
    return finish(plan.status === "ready" ? "nothing_to_do" : "partial");
  }

  const record: LaunchRecord = deps.record ?? {
    canonical_path: plan.canonical_path,
    chat_pane_id: null,
    agents: {},
    updated_at: new Date(now()).toISOString()
  };
  const save = () => {
    record.updated_at = new Date(now()).toISOString();
    writeLaunchRecord(deps.dataDir, record);
  };
  const track = (agent: LaunchAgent, state: LaunchAgentState, detail: string, paneId?: string | null) => {
    const outcome = outcomes.get(agent)!;
    outcome.state = state;
    outcome.detail = detail;
    if (paneId !== undefined) outcome.pane_id = paneId;
    record.agents[agent] = {
      herdr_name: plan.agents.find((candidate) => candidate.agent === agent)!.herdr_name,
      pane_id: outcome.pane_id,
      state,
      detail,
      ...(outcome.member_id ? { member_id: outcome.member_id } : {}),
      updated_at: new Date(now()).toISOString()
    };
    save();
    progress(`${agent}: ${state}${outcome.pane_id ? ` (${outcome.pane_id})` : ""} — ${detail}`);
  };

  const panes = new Map<string, string>();
  let lastPane: string | null = null;
  const resolve = (argv: string[]) => argv.map((arg) => panes.get(arg) ?? arg);
  const stopped = new Set<LaunchAgent>();

  for (const step of plan.steps) {
    if (step.agent && stopped.has(step.agent)) continue;
    let argv = resolve(step.argv).slice(1);
    if (step.kind === "anchor") {
      record.anchor = { state: "creating", pane_id: null };
      save();
    }
    if (step.kind === "chat") {
      record.chat_pane_id = argv[2];
      record.chat_state = "starting";
      save();
    }
    // A failed neighbour leaves its placeholder unresolved; split from the
    // last pane that does exist instead of guessing an ID.
    if (step.kind === "split" && argv.some((arg) => /^<.+>$/.test(arg)) && lastPane) {
      argv = argv.map((arg) => (/^<.+>$/.test(arg) ? lastPane! : arg));
    }

    if (step.kind === "split" && step.agent) track(step.agent, "pane_created", "Creating a fresh shell pane.");
    if (step.kind === "start" && step.agent) {
      const paneId = argv[argv.indexOf("--pane") + 1];
      track(step.agent, "starting", "Starting the agent.", paneId);
    }

    progress(step.description);
    if (step.kind === "focus" && argv.some((arg) => /^<.+>$/.test(arg))) {
      if (destination) destination.focus_error = "Herdr did not return the destination ID; no focus command was sent.";
      progress("Destination ID missing; select the new tab/workspace manually.");
      continue;
    }
    const outcome = runStep(deps.runner, step, argv);
    if (outcome.kind === "ok") {
      if (step.produces) {
        const paneId = createdPaneId(outcome.result);
        if (!paneId) {
          return failAnchorOrAgent(step, "Herdr did not return the new pane ID.", "ambiguous");
        }
        panes.set(step.produces, paneId);
        lastPane = paneId;
        if (step.kind === "anchor") {
          record.anchor = { state: "created", pane_id: paneId };
          save();
          progress(`Layout anchor created (${paneId}).`);
          if (plan.topology !== "here") {
            const tab = recordObject(outcome.result.tab);
            const workspace = recordObject(outcome.result.workspace);
            const textId = (value: unknown) => typeof value === "string" ? value : null;
            destination = { tab_id: textId(tab.tab_id), workspace_id: textId(workspace.workspace_id) ?? textId(tab.workspace_id),
              tab_number: typeof tab.number === "number" ? tab.number : null,
              label: typeof tab.label === "string" ? tab.label : "talking-stick", focused: false };
            if (destination.tab_id) panes.set("<launch-tab>", destination.tab_id);
            if (destination.workspace_id) panes.set("<launch-workspace>", destination.workspace_id);
            progress(`Destination: ${destination.workspace_id ?? "workspace"}, ${destination.tab_id ?? "tab"}${destination.tab_number !== null ? ` (tab ${destination.tab_number})` : ""}, label ${destination.label}; anchor ${paneId}.`);
          }
        }
        if (step.kind === "split" && step.agent) track(step.agent, "pane_created", "Fresh shell pane created.", paneId);
      }
      if (step.kind === "chat") {
        chat.state = "submitted";
        chat.pane_id = argv[2];
        chat.detail = "tt chat command submitted; waiting for its live room membership.";
        record.chat_pane_id = chat.pane_id;
        record.chat_state = "starting";
        save();
        progress(`Chat: submitted (${chat.pane_id}); waiting for live console proof.`);
      }
      if ((step.kind === "start" || step.kind === "prompt") && step.agent) {
        track(step.agent, "started", "Agent is running; waiting for it to join the room.");
      }
      if (step.kind === "focus" && destination) {
        destination.focused = true;
        progress(`Showing ${argv[2]}.`);
      }
      continue;
    }

    const state: LaunchAgentState = outcome.code === "agent_not_ready" ? "blocked"
      : outcome.code && ["pane_not_found", "agent_not_found", "agent_name_in_use", "agent_blocked", "invalid_params", "method_not_found"].includes(outcome.code)
        ? "failed" : "ambiguous";
    progress(`${step.agent ?? step.kind}: ${state} — ${outcome.message}`);
    if (step.kind === "focus") {
      if (destination) destination.focus_error = outcome.message;
      continue;
    }
    if (step.kind === "anchor") {
      record.anchor = { state: state === "ambiguous" ? "ambiguous" : "failed", pane_id: null };
      save();
      chat.state = chat.state === "not_started" ? (state === "ambiguous" ? "ambiguous" : "failed") : chat.state;
      chat.detail = outcome.message;
      for (const agent of plan.agents) {
        if (agent.action === "launch") track(agent.agent, state === "ambiguous" ? "ambiguous" : "failed", `No anchor pane: ${outcome.message}`);
      }
      return finish("partial");
    }
    if (step.kind === "chat") {
      record.chat_state = state === "ambiguous" ? "ambiguous" : "failed";
      save();
      chat.state = state === "ambiguous" ? "ambiguous" : "failed";
      chat.detail = outcome.message;
      chat.pane_id = argv[2];
      continue;
    }
    if (step.agent) {
      track(step.agent, state, outcome.message);
      stopped.add(step.agent);
    }
  }

  await observeJoins(plan, deps, outcomes, track, chat, () => { record.chat_state = "opened"; save(); }, sleep, now);
  const launched = [...outcomes.values()].filter((outcome) =>
    plan.agents.find((agent) => agent.agent === outcome.agent)?.action === "launch"
  );
  const complete = launched.every((outcome) => outcome.state === "confirmed") &&
    (chat.state === "opened" || chat.state === "skipped") &&
    plan.status === "ready" && !destination?.focus_error;
  return finish(complete ? "launched" : "partial");

  function failAnchorOrAgent(step: LaunchStep, message: string, state: LaunchAgentState): WorkspaceLaunchResult {
    if (step.agent) {
      track(step.agent, state, message);
      stopped.add(step.agent);
    } else {
      record.anchor = { state: "ambiguous", pane_id: null };
      save();
      chat.state = "ambiguous";
      chat.detail = message;
    }
    return finish("partial");
  }
}

function recordObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

type StepOutcome =
  | { kind: "ok"; result: Record<string, unknown> }
  | { kind: "error"; code: string | null; message: string };

function runStep(runner: HerdrRunner, step: LaunchStep, args: string[]): StepOutcome {
  const timeoutMs = step.kind === "start" ? AGENT_START_TIMEOUT_MS + CALL_HEADROOM_MS
    : step.kind === "prompt" ? AGENT_PROMPT_TIMEOUT_MS + CALL_HEADROOM_MS
      : undefined;
  try {
    return { kind: "ok", result: runHerdrJson(runner, args, { timeoutMs }) };
  } catch (error) {
    if (error instanceof HerdrError) return { kind: "error", code: error.code, message: error.message };
    return { kind: "error", code: null, message: error instanceof Error ? error.message : String(error) };
  }
}

// Join proof is the member's harness session, process, and start time matching
// the pane we created. Herdr idle is not required: a parked agent can look busy.
async function observeJoins(
  plan: WorkspaceLaunchPlan,
  deps: ExecuteLaunchDeps,
  outcomes: Map<LaunchAgent, LaunchAgentOutcome>,
  track: (agent: LaunchAgent, state: LaunchAgentState, detail: string) => void,
  chat: WorkspaceLaunchResult["chat"],
  confirmChat: () => void,
  sleep: (ms: number) => Promise<void>,
  now: () => number
): Promise<void> {
  const pending = () => [...outcomes.values()].filter((outcome) => outcome.state === "started");
  const deadline = now() + (deps.joinTimeoutMs ?? DEFAULT_JOIN_TIMEOUT_MS);
  const proofDeps = { runner: deps.runner, readStartTime: deps.readStartTime };
  const lastReason = new Map<LaunchAgent, string>();
  const seconds = Math.round((deps.joinTimeoutMs ?? DEFAULT_JOIN_TIMEOUT_MS) / 1000);
  let lastProgress = "";
  const report = () => {
    const summary = [
      `chat ${chat.state}`,
      ...[...outcomes.values()].map((outcome) => `${outcome.agent} ${outcome.state}`)
    ].join(", ");
    if (summary !== lastProgress) {
      deps.onProgress?.(`Waiting for joins (up to ${seconds}s): ${summary}.`);
      lastProgress = summary;
    }
  };

  if (pending().length > 0 || chat.state === "submitted") report();
  while (pending().length > 0 || chat.state === "submitted") {
    let herdrAgents: ReturnType<typeof listHerdrAgents> = [];
    try {
      herdrAgents = listHerdrAgents(deps.runner);
    } catch {
      // A transient listing failure only delays proof until the next poll.
    }
    const members = deps.readMembers() ?? [];
    if (chat.state === "submitted" && chat.pane_id) {
      try {
        const processes = readPaneProcesses(deps.runner, chat.pane_id);
        const consoleMember = members.find((member) => member.status === "active" &&
          member.session_kind === "human_chat" && member.process_liveness === "alive" &&
          member.pid && member.process_started_at?.trim() &&
          processes.some((candidate) => candidate.pid === member.pid) &&
          deps.readStartTime(member.pid)?.trim() === member.process_started_at.trim());
        if (consoleMember) {
          chat.state = "opened";
          chat.detail = `${consoleMember.agent_id} is confirmed running in pane ${chat.pane_id}.`;
          confirmChat();
          deps.onProgress?.(`Chat: confirmed (${chat.pane_id}).`);
        }
      } catch { /* No positive console proof yet; retain submitted state. */ }
    }
    for (const outcome of pending()) {
      const herdrAgent = herdrAgents.find((candidate) => candidate.pane_id === outcome.pane_id);
      if (!herdrAgent) {
        lastReason.set(outcome.agent, `Herdr no longer reports an agent in pane ${outcome.pane_id}.`);
        continue;
      }
      const executable = launchAdapter(outcome.agent).executable;
      for (const member of members.filter((candidate) => isLiveMember(candidate, outcome.agent))) {
        const proof = proveMemberInPane(member, herdrAgent, executable, proofDeps);
        if (proof.confirmed) {
          outcome.member_id = member.agent_id;
          track(outcome.agent, "confirmed", proof.reason);
          break;
        }
        lastReason.set(outcome.agent, proof.reason);
      }
    }
    report();
    if ((pending().length === 0 && chat.state !== "submitted") || now() >= deadline) break;
    await sleep(Math.min(JOIN_POLL_MS, Math.max(0, deadline - now())));
  }

  if (chat.state === "submitted") chat.detail = `Chat command submitted in pane ${chat.pane_id}, but no verified live console within ${seconds}s.`;
  for (const outcome of pending()) {
    const why = lastReason.get(outcome.agent) ?? "no matching member joined";
    outcome.detail = `Started in pane ${outcome.pane_id} but no verified join within ${seconds}s: ${why}`;
  }
}

function nextSteps(
  plan: WorkspaceLaunchPlan,
  chat: WorkspaceLaunchResult["chat"],
  outcomes: LaunchAgentOutcome[]
): string[] {
  const steps: string[] = [];
  if (plan.status === "blocked") {
    steps.push("Fix the failed checks above, then run the same tt up command again.");
    return steps;
  }
  if (chat.state === "failed" || chat.state === "ambiguous") {
    steps.push(`Check the chat pane${chat.pane_id ? ` ${chat.pane_id}` : ""}; run tt chat there if it is not open.`);
  }
  if (chat.state === "inspect") steps.push(`Chat/layout needs inspection: ${chat.detail}`);
  if (chat.state === "submitted") steps.push(`Chat command has not proven it is running in pane ${chat.pane_id}; inspect that pane before submitting it again.`);
  for (const outcome of outcomes) {
    const where = outcome.pane_id ? ` in pane ${outcome.pane_id}` : "";
    switch (outcome.state) {
      case "blocked":
        steps.push(`${outcome.agent}${where} is waiting on a dialog: answer it yourself, then rerun tt up.`);
        break;
      case "ambiguous":
        steps.push(`${outcome.agent}${where} may have started; inspect it before rerunning (tt up will not resend).`);
        break;
      case "started":
        steps.push(`${outcome.agent}${where} is running but has not proven its join; check the pane for a startup dialog and answer it yourself. Do not resend the bootstrap prompt.`);
        break;
      case "failed":
        steps.push(`${outcome.agent} failed: ${outcome.detail}`);
        break;
      case "inspect":
        steps.push(`${outcome.agent}: ${outcome.detail}`);
        break;
      case "not_started":
        steps.push(`${outcome.agent} was not started; resolve the earlier launch uncertainty first.`);
        break;
      default:
        break;
    }
  }
  return steps;
}
