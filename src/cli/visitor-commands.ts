import type { PathRoom, RequestRepliesResult } from "../types.js";
import { readAllStdin } from "./handoff.js";
import { deriveCliIdentity } from "./identity.js";
import { printResult } from "./output.js";
import { getStringOption, hasOption, parseOptionalInteger, parseWaitTimeout, type ParsedCommand } from "./parser.js";
import type { Runtime } from "./runtime.js";

// Visitors: anyone on this host can ask a room's agents a question without
// joining it, and read the answers later. Asking never creates a membership.

const MAX_WAIT_SECONDS = 60;
const POLL_MS = 250;

async function messageBody(parsed: ParsedCommand, positional: string[]): Promise<string> {
  const body = positional.length > 0 ? positional.join(" ") : hasOption(parsed, "stdin") ? await readAllStdin() : "";
  if (body.trim().length === 0) {
    throw new Error("Message body is required (pass as a positional or use --stdin to read from stdin).");
  }
  return body;
}

export async function askRoom(runtime: Runtime, parsed: ParsedCommand, room: PathRoom, rest: string[]): Promise<void> {
  const to = getStringOption(parsed, "to");
  if (!to) throw new Error("Usage: tt room ask <room> --to <agent[,agent]|room> <body...> [--stdin] [--request-key KEY]");
  const body = await messageBody(parsed, rest);
  const identity = deriveCliIdentity(parsed);
  const result = await runtime.commands.askRoom(identity, {
    room_id: room.room_id,
    // Names resolve in the service, after any --request-key match, so a
    // retry finds the original even if the room's members changed.
    to: to === "room" ? "room" : to.split(","),
    body,
    ...(getStringOption(parsed, "request-key") ? { request_key: getStringOption(parsed, "request-key") } : {})
  });
  const replies = `tt room replies ${result.request_id} --timeout 30`;
  printResult(parsed, { ...result, replies }, () => [
    `${result.deduplicated ? "Already asked" : "Asked"} ${result.recipients.join(", ")} in ${room.canonical_path} (request ${result.request_id}).`,
    ...(result.deliveries ?? []).map((delivery) => `  ${delivery.agent_id}: ${delivery.status}`),
    ...(result.return_address ? [`Return address: ${result.return_address.transport} (replies will be pushed)`] : []),
    `Answers: ${replies}`
  ].join("\n"));
}

export async function readReplies(runtime: Runtime, parsed: ParsedCommand, requestId: string | undefined): Promise<void> {
  if (!requestId) throw new Error("Usage: tt room replies <request-id> [--after SEQ] [--limit N] [--timeout SECONDS]");
  const waitMs = parseWaitTimeout(parsed) ?? 0;
  if (waitMs > MAX_WAIT_SECONDS * 1000) throw new Error(`--timeout is at most ${MAX_WAIT_SECONDS} seconds.`);
  const input = { request_id: requestId, after_event_seq: parseOptionalInteger(parsed, "after"),
    limit: parseOptionalInteger(parsed, "limit") };
  // A plain read loop: no receiver registration, no presence, nothing to
  // clean up. A deleted room ends the wait at once with request_not_found.
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  let result: RequestRepliesResult;
  try {
    const deadline = Date.now() + waitMs;
    result = runtime.commands.getRequestReplies(input);
    while (result.replies.length === 0 && Date.now() < deadline && !stop.signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_MS, Math.max(deadline - Date.now(), 0))));
      result = runtime.commands.getRequestReplies(input);
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  // Empty means no answer yet, never that the question is finished. A signal
  // ends the wait early: report that rather than a timeout, and exit 130.
  const interrupted = stop.signal.aborted && result.replies.length === 0;
  if (interrupted) process.exitCode = 130;
  const output = { ...result, timed_out: !interrupted && waitMs > 0 && result.replies.length === 0, interrupted };
  printResult(parsed, output, () => {
    const lines = result.replies.map((reply) =>
      `#${reply.event_seq} ${reply.from_agent_id ?? "unknown"}:\n${(reply.payload?.body ?? "").trimEnd().split("\n").map((line) => `  ${line}`).join("\n")}`);
    if (lines.length === 0) lines.push(`No answers yet to request ${result.request_id}${interrupted ? " (stopped waiting)" : ""}.`);
    // Delivery, receipt, and answering are separate facts; none implies the next.
    lines.push("Recipients:", ...result.recipient_status.map((status) => {
      const delivery = status.delivery
        ? [status.delivery.state ?? status.delivery.status, status.delivery.error_detail].filter(Boolean).join(" ") : "unknown";
      return `  ${status.agent_id}: ${status.in_room ? "" : "left the room; "}delivery ${delivery}; ${
        status.received_at ? `received ${status.received_at}` : "no receipt on record"}; ${status.replied ? "replied" : "no reply yet"}`;
    }));
    if (result.return_deliveries && result.return_deliveries.length > 0) {
      lines.push("Return pushes:", ...result.return_deliveries.map((delivery) => {
        const state = [delivery.status, delivery.error_detail ?? delivery.error].filter(Boolean).join(" ");
        return `  #${delivery.event_seq} via ${delivery.transport}: ${state}; ${delivery.received_at ? `received ${delivery.received_at}` : "unacknowledged"}`;
      }));
    }
    if (result.has_more) lines.push(`More: tt room replies ${result.request_id} --after ${result.cursor_event_seq}`);
    else lines.push(`Later answers: tt room replies ${result.request_id} --after ${result.cursor_event_seq} --timeout 30`);
    return lines.join("\n");
  });
}

export async function replyToRequest(runtime: Runtime, parsed: ParsedCommand, requestId: string | undefined, rest: string[]): Promise<void> {
  if (!requestId) throw new Error("Usage: tt msg reply <request-id> <body...> [--stdin]");
  const body = await messageBody(parsed, rest);
  const result = await runtime.commands.replyToRequestAndWake(deriveCliIdentity(parsed), { request_id: requestId, body });
  printResult(parsed, result, () => {
    const push = result.return_delivery
      ? `; return push ${result.return_delivery.status} via ${result.return_delivery.transport}`
      : "";
    return `Answered request ${result.request_id} (#${result.event_seq}${push}).`;
  });
}
