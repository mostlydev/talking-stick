import { runGuardCommand } from "./guardian.js";
import {
  runInstallCommand,
  runMcpMigrationCommand,
  runSelfUpdateCommand,
  runUninstallCommand
} from "./install-commands.js";
import { handleMsgCommand } from "./msg-commands.js";
import { handleNotesCommand } from "./notes-commands.js";
import type { ParsedCommand } from "./parser.js";
import {
  handleEventsCommand,
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
    name: "install",
    needsRuntime: false,
    startupMaintenance: false,
    internal: false,
    usage: "tt install <harness...> | --all [--print] [--copy] [--link]",
    description: "Install the Talking Stick skill and remove stale MCP registrations.",
    handler: ({ parsed }) => runInstallCommand(parsed)
  },
  {
    name: "uninstall",
    needsRuntime: false,
    startupMaintenance: false,
    internal: false,
    usage: "tt uninstall <harness...> | --all [--print]",
    description: "Remove the Talking Stick skill and stale MCP registrations.",
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
    name: "migrate-mcp",
    needsRuntime: false,
    startupMaintenance: false,
    internal: true,
    usage: "tt migrate-mcp [--reason update|first-run|uninstall|manual] [--quiet]",
    description: "Remove stale Talking Stick MCP registrations.",
    handler: ({ parsed }) => runMcpMigrationCommand(parsed)
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
    usage: "tt state [path]",
    description: "Show room state.",
    handler: ({ runtime, parsed }) => handleStateCommand(requireRuntime(runtime), parsed)
  },
  {
    name: "events",
    needsRuntime: true,
    startupMaintenance: true,
    internal: false,
    usage: "tt events [path] [--after N] [--limit N] [--wait|--follow] [--event TYPE[,TYPE]] [--target self|any|agent]",
    description: "Show room events.",
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
    usage: "tt wait [path] [--timeout 110s]",
    description: "Wait until this agent can claim the stick.",
    handler: ({ runtime, parsed, cliEntryUrl }) =>
      handleWaitCommand(requireRuntime(runtime), parsed, false, cliEntryUrl)
  },
  {
    name: "try",
    needsRuntime: true,
    startupMaintenance: true,
    internal: false,
    usage: "tt try [path]",
    description: "Check turn availability without waiting.",
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
