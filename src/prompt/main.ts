// `rooms prompt`: kept off the main CLI's module graph so a shell can run it
// on every prompt. Showing a segment never fails: on any problem it prints
// nothing and exits 0. Only `init`, run by hand, reports errors.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isStandalone } from "../standalone-mode.js";
import { DEFAULT_PROMPT_FORMAT, formatPrompt } from "./format.js";
import { PROMPT_SHELLS, promptInitScript, shellQuote, type PromptShell } from "./init.js";
import { readPromptState } from "./state.js";

export const PROMPT_USAGE = "rooms prompt [--format FORMAT] [--json] | rooms prompt init <zsh|bash|fish>";

/** Runs `rooms prompt` with the words after `prompt`; returns the exit code. */
export function runPromptCommand(args: readonly string[], out: (text: string) => void = (text) => { process.stdout.write(text); },
  err: (text: string) => void = (text) => { process.stderr.write(text); }): number {
  if (args[0] === "init") {
    const shell = args[1] as PromptShell | undefined;
    if (!shell || !PROMPT_SHELLS.includes(shell)) {
      err(`Usage: rooms prompt init <${PROMPT_SHELLS.join("|")}>\n`);
      return 1;
    }
    out(promptInitScript(shell, promptCommandWords()));
    return 0;
  }
  try {
    let format = DEFAULT_PROMPT_FORMAT;
    let json = false;
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === "--json") json = true;
      else if (args[index] === "--format" && args[index + 1] !== undefined) format = args[++index];
      else if (args[index].startsWith("--format=")) format = args[index].slice("--format=".length);
    }
    const state = readPromptState();
    if (json) out(`${JSON.stringify(state)}\n`);
    else if (state) out(formatPrompt(state, format));
  } catch {
    // A prompt must never show an error.
  }
  return 0;
}

// The fastest way to run the segment from this install: the standalone binary
// itself, or Node on the lean entry beside this file.
function promptCommandWords(): string {
  if (isStandalone()) return `${shellQuote(process.execPath)} prompt`;
  const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "entry.js");
  return `node ${shellQuote(entry)}`;
}
