import { agentStyle, paintStyle, themeStyle, type ChatColorMode } from "./theme.js";
import type { ChatModalKey } from "./chat-input.js";
import { sanitizeChatText } from "./chat-format.js";

export interface MemberMenu {
  agents: string[];
  selected: number;
  target: string | null;
  phase: "members" | "actions" | "confirm";
  stop?: { detail: string; confirmation: string; reason?: string };
}
export type MemberMenuAction = "none" | "close" | "message" | "kick" | "preview_stop" | "kick_stop";

export function createMemberMenu(agents: string[], target?: string): MemberMenu {
  return { agents, selected: 0, target: target ?? null, phase: target ? "actions" : "members" };
}

export function memberMenuKey(state: MemberMenu, key: ChatModalKey): MemberMenuAction {
  if (key === "escape") return "close";
  const count = state.phase === "members" ? state.agents.length : state.phase === "actions" ? 3 : 2;
  if (key === "up" || key === "down") {
    state.selected = count ? (state.selected + (key === "up" ? -1 : 1) + count) % count : 0;
    return "none";
  }
  if (key !== "enter") return "none";
  if (state.phase === "members") {
    state.target = state.agents[state.selected] ?? null;
    if (!state.target) return "close";
    state.phase = "actions";
    state.selected = 0;
    return "none";
  }
  if (state.phase === "actions") {
    if (state.selected === 0) return "message";
    if (state.selected === 2) return "preview_stop";
    state.phase = "confirm";
    state.selected = 0;
    return "none";
  }
  return state.selected === 1 ? state.stop ? "kick_stop" : "kick" : "close";
}

export function renderMemberMenu(state: MemberMenu, maxLines: number, nameOf: (id: string) => string = id => id,
  options: { color?: boolean; color_mode?: ChatColorMode; lost?: ReadonlyMap<string, string> } = {}): string[] {
  const paint = (style: string, text: string) => paintStyle(Boolean(options.color), style, text);
  const label = (id: string) => paint(agentStyle(id, options.color_mode), sanitizeChatText(nameOf(id))) +
    (nameOf(id) === id ? "" : paint(themeStyle("muted", options.color_mode), ` · ${sanitizeChatText(id)}`)) +
    (options.lost?.has(id) ? paint(themeStyle("muted", options.color_mode), ` · ${options.lost.get(id)}`) : "");
  const title = state.phase === "members" ? paint(`1;${themeStyle("accent", options.color_mode)}`, "Room members") : label(state.target ?? "");
  const choices = state.phase === "members" ? state.agents.map(label) : state.phase === "actions"
    ? [paint(themeStyle("command", options.color_mode), "Message"), paint(themeStyle("warn", options.color_mode), "Remove from room…"),
      paint(themeStyle("warn", options.color_mode), "Kick and stop…")]
    : [paint(themeStyle("command", options.color_mode), "Cancel"), paint(themeStyle("error", options.color_mode),
      state.stop ? sanitizeChatText(state.stop.detail) : "Remove from room only")];
  const capacity = Math.max(1, maxLines - 2);
  const start = Math.max(0, state.selected - capacity + 1);
  return [title, ...choices.slice(start, start + capacity).map((choice, i) => {
    const selected = start + i === state.selected;
    let row = `${paint(`1;${themeStyle("accent", options.color_mode)}`, selected ? "›" : " ")} ${choice}`;
    if (selected && options.color) {
      const bg = `\u001b[${themeStyle("selection", options.color_mode, true)}m`;
      row = bg + row.replace(/\u001b\[0m/g, `\u001b[0m${bg}`) + "\u001b[0m";
    }
    return row;
  }), paint(themeStyle("muted", options.color_mode), "↑↓ choose · Enter select · Esc cancel")];
}
