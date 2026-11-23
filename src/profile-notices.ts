// One-time messages for the person who uses this profile (one data directory).
// Each is shown once to a human, in chat or an interactive terminal, and never
// in JSON, hooks, wake envelopes, or anything an agent reads.

export const RENAME_NOTICE_ID = "shrooms-rename";

export const RENAME_NOTICE_TEXT =
  "Talking Stick is now shrooms. Keep using `tt`. Your rooms and settings carried over.";

export const PROFILE_NOTICES: ReadonlyArray<{ id: string; text: string }> = [
  { id: RENAME_NOTICE_ID, text: RENAME_NOTICE_TEXT }
];

/**
 * Whether a CLI run may print a one-time notice: a person at a terminal, not a
 * harness, and not a run whose output another program reads.
 */
export function profileNoticeAllowed(input: {
  json: boolean;
  stdoutTTY: boolean;
  stderrTTY: boolean;
  internal: boolean;
  command: string;
  insideHarness: () => string | null;
}): boolean {
  if (input.json || !input.stdoutTTY || !input.stderrTTY || input.internal) return false;
  // Chat shows the notice in its own transcript.
  if (input.command === "chat") return false;
  return input.insideHarness() === null;
}
