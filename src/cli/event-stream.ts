import { ProtocolError } from "../errors.js";
import type {
  AgentId,
  DerivedIdentity,
  EventType,
  EventTypeFilter,
  RoomEvent,
  TargetAgentFilter,
  WaitForEventsInput
} from "../index.js";
import {
  getStringOption,
  parseOptionalInteger,
  parseWaitTimeout,
  type ParsedCommand
} from "./parser.js";
import { shouldUseJson } from "./output.js";
import type { Runtime } from "./runtime.js";

export interface EventStreamOptions {
  event_type?: EventTypeFilter;
  default_target: TargetAgentFilter;
  force_tail_cursor: boolean;
}

export async function runEventStream(
  runtime: Runtime,
  parsed: ParsedCommand,
  identity: DerivedIdentity,
  roomId: string,
  options: EventStreamOptions
): Promise<void> {
  const follow = parsed.options.has("follow");
  const wait = parsed.options.has("wait");
  if (follow && wait) {
    throw new Error("Pass only one of --wait or --follow.");
  }
  const tailMode = follow || wait || options.force_tail_cursor;
  const explicitAfter = parseOptionalInteger(parsed, "after");
  const afterEventSeq =
    explicitAfter ??
    (tailMode ? runtime.commands.getLatestEventSeq({ room_id: roomId }) : 0);
  const targetAgentId = resolveTargetFilter(
    runtime,
    identity,
    roomId,
    getStringOption(parsed, "target") ?? options.default_target
  );
  const fromAgentId = resolveOptionalAgentSelector(
    runtime,
    identity,
    roomId,
    getStringOption(parsed, "from")
  );
  const waitInput: WaitForEventsInput = {
    agent_id: identity.agent_id,
    room_id: roomId,
    after_event_seq: afterEventSeq,
    event_type: options.event_type,
    target_agent_id: targetAgentId,
    from_agent_id: fromAgentId,
    max_wait_ms: follow || wait ? parseWaitTimeout(parsed) : 0
  };

  if (!follow) {
    const result = await runtime.commands.waitForEvents(waitInput);
    writeEventLines(parsed, result.events);
    return;
  }

  await followEvents(runtime, parsed, waitInput);
}

export function resolveOptionalAgentSelector(
  runtime: Runtime,
  identity: DerivedIdentity,
  roomId: string,
  raw: string | undefined
): AgentId | undefined {
  if (!raw) {
    return undefined;
  }
  return resolveAgentSelector(runtime, identity, roomId, raw);
}

export function resolveAgentSelector(
  runtime: Runtime,
  identity: DerivedIdentity,
  roomId: string,
  raw: string
): AgentId {
  const members = runtime.commands.getRoomState({
    room_id: roomId,
    agent_id: identity.agent_id
  }).members;
  const exact = members.find((member) => member.agent_id === raw);
  if (exact) {
    return exact.agent_id;
  }

  const candidates = members.filter(
    (member) => member.status === "active" && member.display_name === raw
  );
  if (candidates.length === 1) {
    return candidates[0].agent_id;
  }
  if (candidates.length > 1) {
    throw new ProtocolError(
      "ambiguous_recipient",
      `Multiple active room members match '${raw}'.`,
      { candidates: candidates.map((member) => member.agent_id) }
    );
  }

  throw new ProtocolError(
    "unknown_recipient",
    `No active room member matches '${raw}'.`
  );
}

export function parseEventTypeFilter(
  value: string | undefined
): EventTypeFilter | undefined {
  if (!value) {
    return undefined;
  }

  const values = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (values.length === 0) {
    return undefined;
  }
  return values.length === 1 ? (values[0] as EventType) : (values as EventType[]);
}

export function writeEventLines(
  parsed: ParsedCommand,
  events: RoomEvent[]
): void {
  for (const event of events) {
    const line = shouldUseJson(parsed)
      ? JSON.stringify(event)
      : formatEventLine(event);
    process.stdout.write(`${line}\n`);
  }
}

export function formatEventLine(event: RoomEvent): string {
  if (event.event_type === "message_sent") {
    const target = event.to_agent_id ?? "room";
    const hint =
      event.payload?.delivery_hint === "interrupt" ? " [interrupt]" : "";
    return `[${event.created_at}] ${event.from_agent_id ?? "-"} -> ${target}${hint}: ${event.payload?.body ?? ""}`;
  }

  const reason = event.reason ? ` (${event.reason})` : "";
  const target =
    event.from_agent_id && event.to_agent_id
      ? `${event.from_agent_id} -> ${event.to_agent_id}`
      : event.to_agent_id
        ? `-> ${event.to_agent_id}`
        : event.from_agent_id ?? "-";
  return `[${event.created_at}] ${event.event_type} ${target}${reason}`;
}

async function followEvents(
  runtime: Runtime,
  parsed: ParsedCommand,
  input: WaitForEventsInput
): Promise<void> {
  let cursor = input.after_event_seq ?? 0;
  let shouldExit = false;
  const markExit = () => {
    shouldExit = true;
  };

  process.once("SIGTERM", markExit);
  process.once("SIGHUP", markExit);
  process.once("SIGINT", markExit);

  try {
    while (!shouldExit) {
      const result = await runtime.commands.waitForEvents({
        ...input,
        after_event_seq: cursor
      });
      if (result.events.length > 0) {
        writeEventLines(parsed, result.events);
        cursor = result.cursor_event_seq;
      }
    }
  } finally {
    process.off("SIGTERM", markExit);
    process.off("SIGHUP", markExit);
    process.off("SIGINT", markExit);
    process.stderr.write(`cursor_event_seq=${cursor}\n`);
  }
}

function resolveTargetFilter(
  runtime: Runtime,
  identity: DerivedIdentity,
  roomId: string,
  raw: string
): TargetAgentFilter {
  if (raw === "self" || raw === "any") {
    return raw;
  }
  return resolveAgentSelector(runtime, identity, roomId, raw);
}
