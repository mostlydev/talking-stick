import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { acquireLaunchLock } from "./launch-record.js";
import { LAUNCH_AGENTS, type LaunchAgent } from "./workspace-launch.js";

// The agents `tt up` starts when --agents is omitted: one choice for every
// room, plus overrides keyed by a room's canonical path (a room id changes when
// the room is reopened). Kept out of room.toml, which older tt versions reject
// when it carries keys they do not know.
export interface LaunchDefaults {
  agents?: LaunchAgent[];
  rooms?: Record<string, LaunchAgent[]>;
}

export type AgentChoiceSource = "flag" | "room" | "default" | "pair";

export interface AgentChoice {
  agents: LaunchAgent[];
  source: AgentChoiceSource;
  /** Saved agents that are no longer launchable here; never replaced silently. */
  unavailable: LaunchAgent[];
}

// Unsaved launches start this pair, limited to what is installed. Every other
// launcher, Antigravity included, starts only when someone chooses it.
export const DEFAULT_AGENT_PAIR: readonly LaunchAgent[] = ["claude", "codex"];

export function launchDefaultsPath(dataDir: string): string {
  return path.join(dataDir, "launch.json");
}

function agentList(value: unknown, where: string): LaunchAgent[] {
  if (!Array.isArray(value) || value.length === 0 ||
      !value.every((agent) => typeof agent === "string" && (LAUNCH_AGENTS as string[]).includes(agent)) ||
      new Set(value).size !== value.length) {
    throw new Error(`${where} must be a non-empty list of distinct agents (${LAUNCH_AGENTS.join(", ")}).`);
  }
  return value as LaunchAgent[];
}

/** Missing file: nothing saved. A malformed file is an error, never ignored. */
export function readLaunchDefaults(dataDir: string): LaunchDefaults {
  const file = launchDefaultsPath(dataDir);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected an object");
    const { agents, rooms } = parsed as { agents?: unknown; rooms?: unknown };
    const result: LaunchDefaults = {};
    if (agents !== undefined) result.agents = agentList(agents, "agents");
    if (rooms !== undefined) {
      if (!rooms || typeof rooms !== "object" || Array.isArray(rooms)) throw new Error("rooms must be an object");
      result.rooms = Object.fromEntries(Object.entries(rooms).map(([room, list]) => [room, agentList(list, `rooms["${room}"]`)]));
    }
    return result;
  } catch (error) {
    throw new Error(`${file} is not a valid tt up agent choice (${error instanceof Error ? error.message : String(error)}). Fix or delete it.`);
  }
}

/** The saved list for this room: its own override, else the default for every room. */
export function savedAgents(defaults: LaunchDefaults, roomKey: string): { agents: LaunchAgent[]; source: "room" | "default" } | null {
  const room = defaults.rooms?.[roomKey];
  if (room) return { agents: room, source: "room" };
  return defaults.agents ? { agents: defaults.agents, source: "default" } : null;
}

export function resolveAgentChoice(input: {
  requested?: LaunchAgent[];
  defaults: LaunchDefaults;
  roomKey: string;
  launchable: readonly LaunchAgent[];
}): AgentChoice {
  if (input.requested) return { agents: input.requested, source: "flag", unavailable: [] };
  const saved = savedAgents(input.defaults, input.roomKey);
  if (saved) {
    return {
      agents: saved.agents.filter((agent) => input.launchable.includes(agent)),
      source: saved.source,
      unavailable: saved.agents.filter((agent) => !input.launchable.includes(agent))
    };
  }
  return { agents: DEFAULT_AGENT_PAIR.filter((agent) => input.launchable.includes(agent)), source: "pair", unavailable: [] };
}

/**
 * Saves under a lock, re-reading inside it, so two rooms saving at once keep
 * each other's override. A malformed file is refused rather than overwritten.
 * Saving for every room drops this room's override, which would otherwise
 * keep winning here; other rooms' overrides stay.
 */
export function saveAgentChoice(dataDir: string, agents: readonly LaunchAgent[], roomKey: string, scope: "every" | "room"): void {
  const release = acquireLaunchLock(dataDir, launchDefaultsPath(dataDir));
  try {
    const current = readLaunchDefaults(dataDir);
    const list = agentList([...agents], "agents");
    const rooms = { ...current.rooms };
    if (scope === "room") rooms[roomKey] = list;
    else delete rooms[roomKey];
    const next: LaunchDefaults = {
      ...(scope === "every" ? { agents: list } : current.agents ? { agents: current.agents } : {}),
      ...(Object.keys(rooms).length > 0 ? { rooms } : {})
    };
    writeFileAtomic(launchDefaultsPath(dataDir), `${JSON.stringify(next, null, 2)}\n`);
  } finally {
    release();
  }
}
