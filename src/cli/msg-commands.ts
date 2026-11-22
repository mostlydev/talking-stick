import { deriveCliIdentity } from "./identity.js";
import { readAllStdin } from "./handoff.js";
import { attachFile } from "../attachments.js";
import { resolveDataDir } from "../config.js";
import {
  getStringOptions,
  hasOption,
  type ParsedCommand
} from "./parser.js";
import { printResult } from "./output.js";
import {
  resolveAgentSelector,
  runEventStream
} from "./event-stream.js";
import { resolveSessionForNotes } from "./session.js";
import type { Runtime } from "./runtime.js";
import { replyToRequest } from "./visitor-commands.js";

export async function handleMsgCommand(
  runtime: Runtime,
  parsed: ParsedCommand
): Promise<void> {
  const [subcommand, ...rest] = parsed.positionals;
  if (!subcommand) {
    throw new Error("Usage: tt msg <send|recv|reply> [...]. See `tt --help` for details.");
  }

  const subParsed: ParsedCommand = {
    name: `msg ${subcommand}`,
    positionals: rest,
    options: parsed.options
  };

  switch (subcommand) {
    case "send":
      await handleMsgSendCommand(runtime, subParsed);
      return;
    case "recv":
      await handleMsgRecvCommand(runtime, subParsed);
      return;
    case "reply":
      await replyToRequest(runtime, subParsed, rest[0], rest.slice(1));
      return;
    default:
      throw new Error(`Unknown msg subcommand: ${subcommand}`);
  }
}

async function handleMsgSendCommand(
  runtime: Runtime,
  parsed: ParsedCommand
): Promise<void> {
  const identity = deriveCliIdentity(parsed);
  const session = resolveSessionForNotes(runtime, parsed, identity);
  const usesRoomFlag = hasOption(parsed, "room");

  const recipientSelector = usesRoomFlag ? "room" : parsed.positionals[0];
  if (!recipientSelector) {
    throw new Error(
      "Usage: tt msg send <recipient|room> <body...> [--interrupt] [--stdin] [--attach IMAGE]..."
    );
  }

  const bodyStart = usesRoomFlag ? 0 : 1;
  const positionalBody = parsed.positionals.slice(bodyStart).join(" ");
  const body =
    positionalBody.length > 0
      ? positionalBody
      : hasOption(parsed, "stdin")
        ? await readAllStdin()
        : "";
  if (hasOption(parsed, "attach") && getStringOptions(parsed, "attach").length === 0) {
    throw new Error("--attach needs an image file.");
  }
  const attachments = getStringOptions(parsed, "attach").map((file) => attachFile(file, { dataDir: resolveDataDir() }));
  if (body.length === 0 && attachments.length === 0) {
    throw new Error(
      "Message body is required (pass as a positional or use --stdin to read from stdin)."
    );
  }

  const toAgentId =
    recipientSelector === "room"
      ? null
      : resolveAgentSelector(
          runtime,
          identity,
          session.room_id,
          recipientSelector
        );

  const result = await runtime.commands.sendMessageAndWake(identity, {
    room_id: session.room_id,
    body,
    to_agent_id: toAgentId,
    delivery_hint: hasOption(parsed, "interrupt") ? "interrupt" : "normal",
    ...(attachments.length ? { attachments } : {})
  });

  printResult(parsed, result, () => {
    const target = toAgentId ?? "room";
    const hint = hasOption(parsed, "interrupt") ? " interrupt" : "";
    const delivery = result.delivery_status
      ? ` Delivery to ${result.delivery_target ?? target}: ${result.delivery_status}${
          result.delivery_error ? ` (${[result.delivery_error, result.delivery_error_detail].filter(Boolean).join(" ")})` : ""
        }.`
      : "";
    return `Sent${hint} message ${shortEventId(result.event_id)} to ${target}.${delivery}`;
  });
}

async function handleMsgRecvCommand(
  runtime: Runtime,
  parsed: ParsedCommand
): Promise<void> {
  const identity = deriveCliIdentity(parsed);
  const session = resolveSessionForNotes(runtime, parsed, identity);

  await runEventStream(runtime, parsed, identity, session.room_id, {
    event_type: "message_sent",
    default_target: "self",
    force_tail_cursor: false
  });
}

function shortEventId(eventId: string): string {
  return eventId.slice(0, 8);
}
