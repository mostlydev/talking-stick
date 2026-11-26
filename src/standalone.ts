// Entry of the compiled standalone binary (bun build --compile). The mode is
// marked before the CLI module loads, so it never mistakes itself for a
// directly executed script and runs twice.
import { markStandalone } from "./standalone-mode.js";

markStandalone();
// A shell prompt evaluates only the prompt's modules.
const args = process.argv.slice(2);
if (args[0] === "prompt" && !args.includes("--help") && !args.includes("-h")) {
  const { runPromptCommand } = await import("./prompt/main.js");
  process.exitCode = runPromptCommand(args.slice(1));
} else {
  const { runCliMain } = await import("./cli.js");
  await runCliMain();
}
