import type { Handoff } from "../index.js";
import {
  getStringOption,
  hasOption,
  type ParsedCommand
} from "./parser.js";

const DEFAULT_CLI_HANDOFF_STATUS =
  "(human handoff — no structured status provided)";
const DEFAULT_CLI_HANDOFF_NEXT_ACTION =
  "(no explicit guidance — proceed as previously established)";

export async function resolveHandoff(
  parsed: ParsedCommand
): Promise<Handoff> {
  if (hasOption(parsed, "stdin")) {
    const raw = (await readAllStdin()).trim();
    if (!raw) {
      throw new Error(
        "--stdin specified but no input received. Pipe a JSON Handoff or omit --stdin."
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Invalid JSON on stdin: ${(error as Error).message}`);
    }
    return parseHandoffJson(value);
  }

  return {
    status: getStringOption(parsed, "status") ?? DEFAULT_CLI_HANDOFF_STATUS,
    next_action:
      getStringOption(parsed, "next-action") ?? DEFAULT_CLI_HANDOFF_NEXT_ACTION
  };
}

export function parseHandoffJson(value: unknown): Handoff {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Handoff JSON must be an object.");
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.status !== "string" || obj.status.trim() === "") {
    throw new Error("Handoff JSON requires a non-empty `status` string.");
  }
  if (typeof obj.next_action !== "string" || obj.next_action.trim() === "") {
    throw new Error("Handoff JSON requires a non-empty `next_action` string.");
  }
  // Pass optional fields through; the service layer's validateHandoff does
  // final structural validation on artifacts/open_questions/do_not.
  return obj as unknown as Handoff;
}

export async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
