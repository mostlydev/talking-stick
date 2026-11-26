#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isProtocolError } from "./index.js";
import { hasOption, parseCommand } from "./cli/parser.js";
import { printCommandHelp, printHelp, shouldUseJson } from "./cli/output.js";
import { getCommand, helpGroups } from "./cli/registry.js";
import { invokedCommandName } from "./cli/invoked-name.js";
import { createRuntime } from "./cli/runtime.js";
import { runStartupMaintenance } from "./cli/startup-maintenance.js";
import { isStandalone, standaloneRoot } from "./standalone-mode.js";
import { detectInstallSource, isPackageManager, resolveCurrentBinaryPath, STANDALONE_MIGRATION_NOTICE } from "./self-update.js";
import { runStartupUpdate } from "./cli/startup-update.js";
import { profileNoticeAllowed } from "./profile-notices.js";
import { runningInsideHarness } from "./identity.js";

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

  if (!parsed.name && hasOption(parsed, "version")) {
    const version = packageVersion();
    process.stdout.write(shouldUseJson(parsed) ? `${JSON.stringify({ version })}\n` : `${invokedCommandName()} ${version}\n`);
    return;
  }

  if (!parsed.name || parsed.name === "help" || hasOption(parsed, "help")) {
    const targetName = parsed.name === "help" ? parsed.positionals[0] : parsed.name;
    const command = targetName ? getCommand(targetName) : undefined;
    if (command) {
      printCommandHelp(command);
    } else {
      printHelp(helpGroups(), shouldUseJson(parsed) ? undefined : helpNotice());
    }
    return;
  }

  // A shell prompt runs this on every Enter: no startup update, maintenance,
  // notices, or runtime. The fast paths are prompt/entry.js and the binary.
  if (parsed.name === "prompt") {
    const { runPromptCommand } = await import("./prompt/main.js");
    process.exitCode = runPromptCommand(argv.slice(argv.indexOf("prompt") + 1));
    return;
  }

  const command = getCommand(parsed.name);
  if (!command) {
    throw new Error(`Unknown command: ${parsed.name}. Run ${invokedCommandName()} --help for the commands.`);
  }

  if (await runStartupUpdate(parsed)) return;
  await runStartupMaintenance(parsed, import.meta.url);

  if (!command.needsRuntime) {
    await command.handler({ parsed, cliEntryUrl: import.meta.url });
    return;
  }

  const runtime = createRuntime();
  try {
    await command.handler({ parsed, runtime, cliEntryUrl: import.meta.url });
    // After the command's own output, so a notice never mixes into it.
    if (profileNoticeAllowed({ json: shouldUseJson(parsed), stdoutTTY: Boolean(process.stdout.isTTY),
      stderrTTY: Boolean(process.stderr.isTTY), internal: command.internal, command: command.name,
      insideHarness: () => runningInsideHarness() })) {
      try {
        for (const text of runtime.commands.claimProfileNotices()) process.stderr.write(`\n${text}\n`);
      } catch { /* A notice must never fail the command it follows. */ }
    }
  } finally {
    try { await runtime.commands.flushWakes(); } finally { runtime.close(); }
  }
}

// A standalone release keeps package.json beside the binary; a Node install
// has it one level above dist/.
function packageVersion(): string {
  const root = isStandalone() ? standaloneRoot() : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const version = (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : "unknown";
  } catch {
    return "unknown";
  }
}

// Package-manager installs point humans at the standalone binary.
function helpNotice(): string | undefined {
  if (isStandalone()) return undefined;
  const source = detectInstallSource({ binaryPath: resolveCurrentBinaryPath(import.meta.url) });
  return isPackageManager(source) ? STANDALONE_MIGRATION_NOTICE : undefined;
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

// Runs the CLI and turns any error into the stderr payload and exit code
// shared by the Node script and the standalone binary.
export async function runCliMain(argv = process.argv.slice(2)): Promise<void> {
  await runCli(argv).catch((error) => {
    const parsed = parseCommand(argv);
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

if (!isStandalone() && isDirectExecution()) {
  await runCliMain();
}
