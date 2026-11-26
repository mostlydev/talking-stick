// Node entry for shell prompts: `node dist/prompt/entry.js [--format F]`.
// It loads only the prompt's modules, not the CLI's.
import { runPromptCommand } from "./main.js";

process.exitCode = runPromptCommand(process.argv.slice(2));
