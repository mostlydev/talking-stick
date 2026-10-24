import readline from "node:readline";
import { LAUNCH_AGENTS, launchAdapter, type LaunchAgent } from "../workspace-launch.js";
import { agentStyle, paintStyle, terminalColorMode, themeStyle, type ChatColorMode } from "./theme.js";

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

export function renderAgentPicker(picker: AgentPicker, roomName: string, color: boolean, mode: ChatColorMode = "256"): string[] {
  const paint = (style: string, text: string) => paintStyle(color, style, text);
  const width = Math.max(...picker.rows.map((row) => LABELS[row.agent].length));
  const lines = [`Start which agents in ${paint("1", roomName)}?`, ""];
  picker.rows.forEach((row, index) => {
    const selected = index === picker.cursor;
    const label = LABELS[row.agent].padEnd(width);
    if (row.unavailable) {
      lines.push(paint(themeStyle("muted", mode), `    -   ${label}  ${row.unavailable}`));
      return;
    }
    const box = picker.checked.has(row.agent) ? "[x]" : "[ ]";
    const note = launchAdapter(row.agent).experimental ? paint(themeStyle("muted", mode), "  experimental") : "";
    const text = `${selected ? paint(themeStyle("accent", mode), "❯") : " "} ${box} ${paint(`1;${agentStyle(row.agent, mode)}`, label)}${note}`;
    // Each inner reset would end the highlight, so restore it after every one.
    const highlight = `\u001b[${themeStyle("selection", mode, true)}m`;
    lines.push(selected && color
      ? `${highlight}  ${text.replaceAll("\u001b[0m", `\u001b[0m${highlight}`)}\u001b[K\u001b[0m`
      : `  ${text}`);
  });
  const option = (scope: PickerScope, text: string) => picker.scope === scope
    ? paint(`1;${themeStyle("accent", mode)}`, `‹ ${text} ›`)
    : paint(themeStyle("muted", mode), `  ${text}  `);
  lines.push("", `  Remember for  ${option("every", "every room")} ${option("room", "this room")}`, "",
    paint(themeStyle("muted", mode), "↑↓ move · Space toggle · ←→ remember · Enter start · Esc cancel"));
  return lines;
}

export interface PickerTerminal {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  env?: NodeJS.ProcessEnv;
}

/** Draws the picker in place and resolves with the choice, or null on Esc/Ctrl-C. */
export async function runAgentPicker(picker: AgentPicker, roomName: string, terminal: PickerTerminal):
    Promise<{ agents: LaunchAgent[]; scope: PickerScope } | null> {
  const { input, output } = terminal;
  const color = !terminal.env?.NO_COLOR;
  const mode = terminalColorMode(terminal.env);
  let drawn = 0;
  const draw = () => {
    const lines = renderAgentPicker(picker, roomName, color, mode);
    output.write(`${drawn > 0 ? `\u001b[${drawn - 1}F` : ""}\r\u001b[J${lines.join("\r\n")}`);
    drawn = lines.length;
  };
  readline.emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  input.setRawMode?.(true);
  output.write("\u001b[?25l");
  try {
    draw();
    return await new Promise((resolve) => {
      const onKey = (_text: string | undefined, key: readline.Key | undefined) => {
        const name = key?.ctrl && key.name === "c" ? "cancel"
          : ({ up: "up", k: "up", down: "down", j: "down", space: "toggle", left: "left", right: "right",
            return: "enter", enter: "enter", escape: "cancel", q: "cancel" } as Record<string, PickerKey>)[key?.name ?? ""];
        if (!name) return;
        const outcome = picker.key(name);
        draw();
        if (outcome.kind === "pending") return;
        input.off("keypress", onKey);
        resolve(outcome.kind === "done" ? { agents: outcome.agents, scope: outcome.scope } : null);
      };
      input.on("keypress", onKey);
      input.resume();
    });
  } finally {
    input.setRawMode?.(wasRaw);
    input.pause();
    output.write("\u001b[?25h\r\n");
  }
}
