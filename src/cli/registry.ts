import { runGuardCommand } from "./guardian.js";
import { runGrokSessionHookCommand } from "./grok-session-hook.js";
import {
  runInstallCommand,
  runSelfUpdateCommand,
  runUninstallCommand
} from "./install-commands.js";
import { handleInstructionsCommand } from "./instructions-commands.js";
import { handleMsgCommand } from "./msg-commands.js";
import { handleNotesCommand } from "./notes-commands.js";
import type { ParsedCommand } from "./parser.js";
import {
  handleEventsCommand,
  handleHealthCommand,
  handleJoinCommand,
  handleKickCommand,
  handleLeaveCommand,
  handleListCommand,
  handleStateCommand,
  handleWhoAmICommand
} from "./room-commands.js";
import type { Runtime } from "./runtime.js";
import {
  handleAssignCommand,
  handlePassCommand,
  handleReleaseCommand,
  handleStandbyCommand,
  handleTakeCommand,
  handleWaitCommand
} from "./turn-commands.js";

export interface CommandContext {
  parsed: ParsedCommand;
  runtime?: Runtime;
  cliEntryUrl: string;
}

export interface CommandEntry {
  name: string;
  aliases?: string[];
  needsRuntime: boolean;
  startupMaintenance: boolean;
  internal: boolean;
  usage: string;
  description: string;
  handler: (context: CommandContext) => void | Promise<void>;
}

export const COMMAND_REGISTRY: CommandEntry[] = [
  {
    name: "guard",
    needsRuntime: false,
    startupMaintenance: false,
    internal: true,
    usage: "tt guard ...",
    description: "Run an internal lease heartbeat guardian.",
    handler: ({ parsed }) => runGuardCommand(parsed)
  },
  {
    name: "grok-session-hook",
    needsRuntime: false,
    startupMaintenance: false,
    internal: true,
    usage: "tt grok-session-hook",
    description: "Record Grok hook session context for identity resolution.",
    handler: () => runGrokSessionHookCommand()
  },
  {
    name: "install",
    needsRuntime: false,
    startupMaintenance: false,
    internal: false,
    usage: "tt install <harness...> | --all [--print] [--copy] [--link] [--replace]",
    description: "Install or explicitly replace the Talking Stick skill.",
    handler: ({ parsed }) => runInstallCommand(parsed)
  },
  {
    name: "uninstall",
    needsRuntime: false,
    startupMaintenance: false,
    internal: false,
    usage: "tt uninstall <harness...|agents> | --all | --shared [--print]",
    description: "Remove the Talking Stick skill.",
    handler: ({ parsed }) => runUninstallCommand(parsed)
  },
  {
    name: "self-update",
    needsRuntime: false,
    startupMaintenance: false,
    internal: false,
    usage: "tt self-update [--print] [--manager npm|pnpm|yarn|bun]",
    description: "Update the globally installed tt package.",
    handler: ({ parsed, cliEntryUrl }) => runSelfUpdateCommand(parsed, cliEntryUrl)
  },
  {
    name: "instructions",
    needsRuntime: false,
    startupMaintenance: true,
    internal: false,
    usage: "tt instructions [show|edit|update|reset] [--harness NAME] [--scope SCOPE] [--replace]",
    description: "Show, edit, safely update, or reset collaboration instructions.",
    handler: ({ parsed }) => handleInstructionsCommand(parsed)
  },
  {
    name: "whoami",
    needsRuntime: false,
    startupMaintenance: true,
    internal: false,
    usage: "tt whoami [--explain]",
    description: "Show the CLI identity that would be used.",
    handler: ({ parsed }) => handleWhoAmICommand(parsed)
  },
  {
    name: "list",
    needsRuntime: true,
    startupMaintenance: true,
    internal: false,
    usage: "tt list [path]",
    description: "List rooms under a path.",
    handler: ({ runtime, parsed }) => handleListCommand(requireRuntime(runtime), parsed)
  },
  {
    name: "join",
    needsRuntime: true,
    startupMaintenance: true,
    internal: false,
    usage: "tt join [path] [--force-new]",
    description: "Join the room for a workspace path.",
    handler: ({ runtime, parsed }) => handleJoinCommand(requireRuntime(runtime), parsed)
  },
  {
    name: "leave",
    needsRuntime: true,
    startupMaintenance: true,
    internal: false,
    usage: "tt leave [path]",
    description: "Leave this agent's room membership.",
    handler: ({ runtime, parsed }) => handleLeaveCommand(requireRuntime(runtime), parsed)
  },
  {
    name: "kick",
    needsRuntime: true,
    startupMaintenance: true,
    internal: false,
    usage: "tt kick <agent_id> [path] [--reason TEXT] [--force]",
    description: "Kick an idle member out of the room.",
    handler: ({ runtime, parsed }) => handleKickCommand(requireRuntime(runtime), parsed)
  },
  {
    name: "state",
    needsRuntime: true,
    startupMaintenance: true,
    internal: false,
    usage: "tt state [path] [--all]",
    description: "Show compact room state.",
    handler: ({ runtime, parsed }) => handleStateCommand(requireRuntime(runtime), parsed)
  },
  {
    name: "health",
    aliases: ["status"],
    needsRuntime: true,
    startupMaintenance: true,
    internal: false,
    usage: "tt health [path] [--verbose|--all]",
    description: "Show a concise room health action card.",
    handler: ({ runtime, parsed }) => handleHealthCommand(requireRuntime(runtime), parsed)
  },
  {
    name: "events",
    needsRuntime: true,
    startupMaintenance: true,
    internal: false,
    usage: "tt events [path] [--all] [--after N] [--limit N] [--wait|--follow] [--event TYPE[,TYPE]] [--target self|any|agent]",
    description: "Show or follow room events for audit/debug and legacy receive loops.",
    handler: ({ runtime, parsed }) => handleEventsCommand(requireRuntime(runtime), parsed)
  },
  {
    name: "msg",
    needsRuntime: true,
    startupMaintenance: true,
    internal: false,
    usage: "tt msg <send|recv> [...]",
    description: "Send or receive transient messages on a room's event stream.",
    handler: ({ runtime, parsed }) => handleMsgCommand(requireRuntime(runtime), parsed)
  },
  {
    name: "wait",
    needsRuntime: true,
    startupMaintenance: true,
    internal: false,
    usage: "tt wait [path] [--timeout 110s] [--park] [--after N]",
    description: "Long-poll for ownership and room events using the saved cursor.",
    handler: ({ runtime, parsed, cliEntryUrl }) =>
      handleWaitCommand(requireRuntime(runtime), parsed, false, cliEntryUrl)
  },
  {
    name: "standby",
    needsRuntime: true,
    startupMaintenance: true,
    internal: false,
    usage: "tt standby [path] [--wake cmux|manual]",
    description: "Park without a listener and register an optional wake endpoint.",
    handler: ({ runtime, parsed }) =>
      handleStandbyCommand(requireRuntime(runtime), parsed)
  },
  {
    name: "try",
    needsRuntime: true,
    startupMaintenance: true,
    internal: false,
    usage: "tt try [path] [--park] [--after N] [--target self|any|agent]",
    description: "Check turn and event availability without waiting.",
    handler: ({ runtime, parsed, cliEntryUrl }) =>
      handleWaitCommand(requireRuntime(runtime), parsed, true, cliEntryUrl)
  },
  {
    name: "take",
    aliases: ["takeover"],
    needsRuntime: true,
    startupMaintenance: true,
    internal: false,
    usage: "tt take [path] [--reason TEXT] [--operator-requested]",
    description: "Take the stick when takeover or operator override is allowed.",
    handler: ({ runtime, parsed, cliEntryUrl }) =>
      handleTakeCommand(requireRuntime(runtime), parsed, cliEntryUrl)
  },
  {
    name: "release",
    needsRuntime: true,
    startupMaintenance: true,
    internal: false,
    usage: "tt release [path] (--status TEXT --next-action TEXT | --stdin)",
    description: "Release the stick to the normal sequence.",
    handler: ({ runtime, parsed }) => handleReleaseCommand(requireRuntime(runtime), parsed)
  },
  {
    name: "pass",
    needsRuntime: true,
    startupMaintenance: true,
    internal: false,
    usage: "tt pass [path] (--status TEXT --next-action TEXT | --stdin)",
    description: "Pass this turn, normally via release.",
    handler: ({ runtime, parsed }) => handlePassCommand(requireRuntime(runtime), parsed)
  },
  {
    name: "assign",
    needsRuntime: true,
    startupMaintenance: true,
    internal: false,
    usage: "tt assign <target|next> [path] (--status TEXT --next-action TEXT | --stdin)",
    description: "Assign the next turn to a specific active member.",
    handler: ({ runtime, parsed }) => handleAssignCommand(requireRuntime(runtime), parsed)
  },
  {
    name: "notes",
    needsRuntime: true,
    startupMaintenance: true,
    internal: false,
    usage: "tt notes <add|list> [...]",
    description: "Add or list non-owner notes.",
    handler: ({ runtime, parsed }) => handleNotesCommand(requireRuntime(runtime), parsed)
  }
];

export function getCommand(name: string): CommandEntry | undefined {
  return COMMAND_REGISTRY.find(
    (command) => command.name === name || command.aliases?.includes(name)
  );
}

function requireRuntime(runtime: Runtime | undefined): Runtime {
  if (!runtime) {
    throw new Error("Internal CLI error: command requires a runtime.");
  }
  return runtime;
}
