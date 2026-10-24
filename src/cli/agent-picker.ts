import readline from "node:readline";
import { LAUNCH_AGENTS, launchAdapter, type LaunchAgent } from "../workspace-launch.js";
import { agentStyle, paintStyle, terminalColorMode, themeStyle, type ChatColorMode } from "./theme.js";
import { textWidth, truncateStyled } from "./chat-view.js";

const LABELS: Record<LaunchAgent, string> = {
  claude: "Claude Code", codex: "Codex", antigravity: "Antigravity", grok: "Grok", opencode: "OpenCode"
};

export interface PickerAgent {
  agent: LaunchAgent;
  /** Why it cannot start here, e.g. "not installed"; undefined when it can. */
  unavailable?: string;
}

export type PickerScope = "every" | "room";
export type PickerKey = "up" | "down" | "toggle" | "left" | "right" | "enter" | "cancel";
export type PickerOutcome = { kind: "pending" } | { kind: "cancel" } | { kind: "done"; agents: LaunchAgent[]; scope: PickerScope };

export class AgentPicker {
  readonly rows: PickerAgent[];
  readonly checked = new Set<LaunchAgent>();
  cursor: number;
  scope: PickerScope;

  constructor(agents: PickerAgent[], preselected: readonly LaunchAgent[], scope: PickerScope = "every") {
    this.rows = [...agents].sort((a, b) => Number(Boolean(a.unavailable)) - Number(Boolean(b.unavailable)) ||
      LAUNCH_AGENTS.indexOf(a.agent) - LAUNCH_AGENTS.indexOf(b.agent));
    for (const row of this.rows) if (!row.unavailable && preselected.includes(row.agent)) this.checked.add(row.agent);
    this.cursor = Math.max(0, this.rows.findIndex((row) => !row.unavailable));
    this.scope = scope;
  }

  key(key: PickerKey): PickerOutcome {
    const selectable = this.rows.flatMap((row, index) => row.unavailable ? [] : [index]);
    const at = selectable.indexOf(this.cursor);
    if (key === "up" && at > 0) this.cursor = selectable[at - 1];
    if (key === "down" && at >= 0 && at < selectable.length - 1) this.cursor = selectable[at + 1];
    if (key === "toggle" && at >= 0) {
      const agent = this.rows[this.cursor].agent;
      if (!this.checked.delete(agent)) this.checked.add(agent);
    }
    if (key === "left") this.scope = "every";
    if (key === "right") this.scope = "room";
    if (key === "cancel") return { kind: "cancel" };
    // Enter with nothing ticked does nothing: there is no empty launch.
    if (key === "enter" && this.checked.size > 0) {
      return { kind: "done", agents: this.rows.map((row) => row.agent).filter((agent) => this.checked.has(agent)), scope: this.scope };
    }
    return { kind: "pending" };
  }
}

export interface PickerSize { columns: number; rows: number }

// Control characters in a directory name must not reach the terminal.
function printable(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

const SCOPE_LINE = "  Remember for  ‹ every room ›   this room  ";

/**
 * Whether every agent row and the remember line fit whole. A choice that is
 * cut off or scrolled away must never be launchable, so a smaller terminal
 * gets a notice and accepts only Esc until it is enlarged.
 */
export function pickerFits(picker: AgentPicker, size: PickerSize): boolean {
  const width = Math.max(...picker.rows.map((row) => LABELS[row.agent].length));
  const widest = Math.max(textWidth(SCOPE_LINE), ...picker.rows.filter((row) => !row.unavailable)
    .map((row) => textWidth(`  ❯ [x] ${LABELS[row.agent].padEnd(width)}${launchAdapter(row.agent).experimental ? "  experimental" : ""}`)));
  return size.columns > widest && size.rows >= picker.rows.length + 1;
}

/**
 * Lines that fit the terminal: none wider than the columns, so nothing wraps,
 * and no more than the rows, dropping spacers, then hints, then the title.
 */
export function renderAgentPicker(picker: AgentPicker, roomName: string, color: boolean, mode: ChatColorMode = "256",
  size: PickerSize = { columns: 80, rows: 24 }): string[] {
  const paint = (style: string, text: string) => paintStyle(color, style, text);
  if (!pickerFits(picker, size)) {
    return ["Terminal too small to choose agents.", "Enlarge it, or press Esc to cancel."]
      .map((line) => truncateStyled(line, Math.max(1, size.columns - 1))).slice(0, Math.max(1, size.rows));
  }
  const fit = (text: string) => truncateStyled(text, Math.max(1, size.columns - 1));
  const highlight = `\u001b[${themeStyle("selection", mode, true)}m`;
  const width = Math.max(...picker.rows.map((row) => LABELS[row.agent].length));
  const title = fit(`Start which agents in ${paint("1", printable(roomName))}?`);
  const rows = picker.rows.map((row, index) => {
    const label = LABELS[row.agent].padEnd(width);
    if (row.unavailable) return fit(paint(themeStyle("muted", mode), `    -   ${label}  ${row.unavailable}`));
    const selected = index === picker.cursor;
    const box = picker.checked.has(row.agent) ? "[x]" : "[ ]";
    const note = launchAdapter(row.agent).experimental ? paint(themeStyle("muted", mode), "  experimental") : "";
    const text = fit(`  ${selected ? paint(themeStyle("accent", mode), "❯") : " "} ${box} ${paint(`1;${agentStyle(row.agent, mode)}`, label)}${note}`);
    // Each inner reset would end the highlight, so restore it after every one.
    return selected && color ? `${highlight}${text.replaceAll("\u001b[0m", `\u001b[0m${highlight}`)}\u001b[K\u001b[0m` : text;
  });
  const option = (scope: PickerScope, text: string) => picker.scope === scope
    ? paint(`1;${themeStyle("accent", mode)}`, `‹ ${text} ›`)
    : paint(themeStyle("muted", mode), `  ${text}  `);
  const scope = fit(`  Remember for  ${option("every", "every room")} ${option("room", "this room")}`);
  const hints = fit(paint(themeStyle("muted", mode), "↑↓ move · Space toggle · ←→ remember · Enter start · Esc cancel"));
  const layouts = [
    [title, "", ...rows, "", scope, "", hints],
    [title, ...rows, scope, hints],
    [title, ...rows, scope],
    [...rows, scope]
  ];
  const lines = layouts.find((layout) => layout.length <= size.rows) ?? layouts.at(-1)!;
  return lines.slice(0, Math.max(1, size.rows));
}

export interface PickerTerminal {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  env?: NodeJS.ProcessEnv;
}

/**
 * Draws the picker on the alternate screen, so wrapping or a resize can never
 * corrupt scrollback, and resolves with the choice, or null on Esc, Ctrl-C or
 * the end of input. The terminal is restored on every path.
 */
export async function runAgentPicker(picker: AgentPicker, roomName: string, terminal: PickerTerminal):
    Promise<{ agents: LaunchAgent[]; scope: PickerScope } | null> {
  const { input, output } = terminal;
  const color = !terminal.env?.NO_COLOR;
  const mode = terminalColorMode(terminal.env);
  const size = () => ({ columns: output.columns || 80, rows: output.rows || 24 });
  const draw = () => {
    const lines = renderAgentPicker(picker, roomName, color, mode, size());
    output.write(`\u001b[H\u001b[J${lines.join("\r\n")}`);
  };
  let settle: (choice: { agents: LaunchAgent[]; scope: PickerScope } | null) => void = () => {};
  const onKey = (_text: string | undefined, key: readline.Key | undefined) => {
    const name = key?.ctrl && key.name === "c" ? "cancel"
      : ({ up: "up", k: "up", down: "down", j: "down", space: "toggle", left: "left", right: "right",
        return: "enter", enter: "enter", escape: "cancel", q: "cancel" } as Record<string, PickerKey>)[key?.name ?? ""];
    if (!name || (name !== "cancel" && !pickerFits(picker, size()))) return;
    const outcome = picker.key(name);
    if (outcome.kind === "pending") { draw(); return; }
    settle(outcome.kind === "done" ? { agents: outcome.agents, scope: outcome.scope } : null);
  };
  const onEnd = () => settle(null);
  readline.emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  try {
    input.setRawMode?.(true);
    output.write("\u001b[?1049h\u001b[?25l");
    return await new Promise((resolve) => {
      settle = resolve;
      input.on("keypress", onKey);
      input.once("end", onEnd);
      input.once("error", onEnd);
      output.on("resize", draw);
      draw();
      input.resume();
    });
  } finally {
    input.off("keypress", onKey);
    input.off("end", onEnd);
    input.off("error", onEnd);
    output.off("resize", draw);
    input.setRawMode?.(wasRaw);
    input.pause();
    output.write("\u001b[?25h\u001b[?1049l");
  }
}
