#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isProtocolError } from "./index.js";
import { hasOption, parseCommand } from "./cli/parser.js";
import { printCommandHelp, printHelp, shouldUseJson } from "./cli/output.js";
import { getCommand } from "./cli/registry.js";
import { createRuntime } from "./cli/runtime.js";
import { runStartupMaintenance } from "./cli/startup-maintenance.js";

export { checkGuardianLiveness } from "./cli/guardian.js";
export { parseHandoffJson } from "./cli/handoff.js";
export {
  COORDINATION_PROMPT,
  formatRelativeTime,
  prepareJsonResult,
  shouldUseJson,
  withCoordinationPrompt
} from "./cli/output.js";
export {
  shouldAutoSyncInstalledSkills
} from "./cli/startup-maintenance.js";

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseCommand(argv);

  if (!parsed.name || parsed.name === "help" || hasOption(parsed, "help")) {
    const targetName = parsed.name === "help" ? parsed.positionals[0] : parsed.name;
    const command = targetName ? getCommand(targetName) : undefined;
    if (command) {
      printCommandHelp(command);
    } else {
      printHelp();
    }
    return;
  }

  const command = getCommand(parsed.name);
  if (!command) {
    throw new Error(`Unknown command: ${parsed.name}`);
  }

  await runStartupMaintenance(parsed, import.meta.url);

  if (!command.needsRuntime) {
    await command.handler({ parsed, cliEntryUrl: import.meta.url });
    return;
  }

  const runtime = createRuntime();
  try {
    await command.handler({ parsed, runtime, cliEntryUrl: import.meta.url });
  } finally {
    runtime.close();
  }
}

function isDirectExecution(): boolean {
  const argvPath = process.argv[1];
  if (!argvPath) {
    return false;
  }

  try {
    return fs.realpathSync(argvPath) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(argvPath) === fileURLToPath(import.meta.url);
  }
}

if (isDirectExecution()) {
  await runCli().catch((error) => {
    const parsed = parseCommand(process.argv.slice(2));
    if (shouldUseJson(parsed)) {
      const payload = isProtocolError(error)
        ? error.toJSON()
        : {
            error: "cli_error",
            message: error instanceof Error ? error.message : String(error)
          };
      process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      const message = isProtocolError(error)
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
      process.stderr.write(`${message}\n`);
    }
    process.exit(1);
  });
}
