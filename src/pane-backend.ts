import { createSystemHerdrRunner, createSystemHerdrStartRunner, readHerdrContext, type HerdrContext, type HerdrRunner, type HerdrStartRunner } from "./herdr.js";
import { createTmuxHerdrRunner, readTmuxContext } from "./tmux.js";
import type { RoomMember } from "./types.js";

// The pane manager tt up drives: Herdr when this process runs in a Herdr pane,
// otherwise tmux when it runs in a tmux pane. Herdr wins inside tmux-in-Herdr.
export type PaneBackend = "herdr" | "tmux";

export interface PaneSession {
  backend: PaneBackend | null;
  runner: HerdrRunner;
  startRunner: HerdrStartRunner;
  context: HerdrContext | null;
}

export function detectPaneBackend(env: NodeJS.ProcessEnv): PaneBackend | null {
  if (readHerdrContext(env)) return "herdr";
  if (env.TMUX && env.TMUX_PANE?.trim()) return "tmux";
  return null;
}

export function openPaneSession(
  env: NodeJS.ProcessEnv,
  options: { runner?: HerdrRunner; startRunner?: HerdrStartRunner; readMembers?: () => readonly RoomMember[] } = {}
): PaneSession {
  const backend = detectPaneBackend(env);
  if (backend === "tmux") {
    const runner = options.runner ?? createTmuxHerdrRunner({ env, readMembers: options.readMembers });
    return { backend, runner, startRunner: options.startRunner ?? (async (args, opts) => runner(args, opts)), context: readTmuxContext(env, runner) };
  }
  const runner = options.runner ?? createSystemHerdrRunner(env);
  const startRunner = options.startRunner ?? (options.runner ? async (args, opts) => runner(args, opts) : createSystemHerdrStartRunner(env));
  return { backend, runner, startRunner, context: readHerdrContext(env) };
}
