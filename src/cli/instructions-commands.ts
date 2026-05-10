import {
  editInstructions,
  parseInstructionScope,
  resetInstructions,
  showInstructions,
  type EditableInstructionScope
} from "../instructions.js";
import { deriveCliIdentity } from "./identity.js";
import {
  getStringOption,
  hasOption,
  type ParsedCommand
} from "./parser.js";
import { printResult } from "./output.js";

export async function handleInstructionsCommand(
  parsed: ParsedCommand
): Promise<void> {
  const [subcommand = "show", ...rest] = parsed.positionals;
  const subParsed: ParsedCommand = {
    name: `instructions ${subcommand}`,
    positionals: rest,
    options: parsed.options
  };

  switch (subcommand) {
    case "show":
      handleInstructionsShowCommand(subParsed);
      return;
    case "edit":
      await handleInstructionsEditCommand(subParsed);
      return;
    case "reset":
      handleInstructionsResetCommand(subParsed);
      return;
    default:
      throw new Error(`Unknown instructions subcommand: ${subcommand}`);
  }
}

function handleInstructionsShowCommand(parsed: ParsedCommand): void {
  repairBooleanFlag(parsed, "json", 0);
  repairBooleanFlag(parsed, "text", 0);
  const contextPath = resolveContextPathArg(parsed);
  const scope = parseInstructionScope(getStringOption(parsed, "scope"));
  const identity = deriveCliIdentity(parsed);
  const result = showInstructions({
    harness: getStringOption(parsed, "harness"),
    scope,
    options: {
      contextPath,
      identity
    }
  });

  printResult(parsed, result, () => {
    if (result.text.trim().length > 0) {
      return result.text;
    }
    return `No ${result.scope} instructions found for ${result.harness}.`;
  });
}

async function handleInstructionsEditCommand(
  parsed: ParsedCommand
): Promise<void> {
  repairBooleanFlag(parsed, "json", 0);
  repairBooleanFlag(parsed, "text", 0);
  repairBooleanFlag(parsed, "user", 0);
  repairBooleanFlag(parsed, "project", 0);
  const contextPath = resolveContextPathArg(parsed);
  const scope = resolveEditableScope(parsed, false);
  const result = await editInstructions({
    scope,
    options: { contextPath }
  });

  printResult(parsed, result, () => {
    if (result.opened) {
      return `Opened ${result.scope} instructions: ${result.path}`;
    }
    return [
      `Instructions file ready: ${result.path}`,
      "Set $VISUAL or $EDITOR to edit it from this command."
    ].join("\n");
  });
}

function handleInstructionsResetCommand(parsed: ParsedCommand): void {
  repairBooleanFlag(parsed, "json", 0);
  repairBooleanFlag(parsed, "text", 0);
  repairBooleanFlag(parsed, "user", 0);
  repairBooleanFlag(parsed, "project", 0);
  const contextPath = resolveContextPathArg(parsed);
  const scope = resolveEditableScope(parsed, true);
  const result = resetInstructions({
    scope,
    options: { contextPath }
  });

  printResult(parsed, result, () => {
    if (result.removed) {
      return `Removed ${result.scope} instructions: ${result.path}`;
    }
    return `No ${result.scope} instructions file at ${result.path}`;
  });
}

function resolveEditableScope(
  parsed: ParsedCommand,
  requireExplicit: boolean
): EditableInstructionScope {
  const wantsUser = hasOption(parsed, "user");
  const wantsProject = hasOption(parsed, "project");
  if (wantsUser && wantsProject) {
    throw new Error("Pass only one of --user or --project.");
  }
  if (wantsProject) {
    return "project";
  }
  if (wantsUser || !requireExplicit) {
    return "user";
  }
  throw new Error("Pass --user or --project to choose which instructions to reset.");
}

function resolveContextPathArg(parsed: ParsedCommand): string {
  const pathOption = parsed.options.get("path");
  if (pathOption === true) {
    throw new Error("--path requires a value.");
  }
  return pathOption ?? parsed.positionals[0] ?? process.cwd();
}

function repairBooleanFlag(
  parsed: ParsedCommand,
  key: string,
  insertAt: number
): void {
  const value = parsed.options.get(key);
  if (typeof value === "string") {
    parsed.positionals.splice(insertAt, 0, value);
    parsed.options.set(key, true);
  }
}
