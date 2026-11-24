import path from "node:path";
import { isStandalone } from "../standalone-mode.js";

/** The two names of this one program: rooms for people, tt for agents, hooks and scripts. */
export type CommandName = "rooms" | "tt";

/**
 * Which name this process was started as. Under Node the script path in
 * argv[1] keeps the name of the link that was run; a compiled binary keeps it
 * in argv0. Anything else, such as node dist/cli.js, is tt.
 */
export function invokedCommandName(input: { argv?: readonly string[]; argv0?: string; standalone?: boolean } = {}): CommandName {
  const standalone = input.standalone ?? isStandalone();
  const invoked = standalone ? input.argv0 ?? process.argv0 : (input.argv ?? process.argv)[1];
  if (!invoked) return "tt";
  const base = path.basename(invoked.replace(/\\/g, "/")).replace(/\.(exe|cmd|js|mjs)$/i, "").toLowerCase();
  return base === "rooms" ? "rooms" : "tt";
}

/** Shows a usage line, written with tt, under the name the person typed. */
export function usageFor(usage: string, name: CommandName): string {
  return name === "tt" ? usage : usage.replace(/(^|\n)(\s*)tt(?= |$)/g, `$1$2${name}`);
}
