import type { LostMember } from "./types.js";

type LossFacts = Pick<LostMember, "harness_name" | "process_kind" | "hook_reason">;

/**
 * Why a member was lost, in words an operator or the agent can act on.
 * A Codex app-server reports SessionEnd with reason "other" both when it
 * unloads an idle conversation and when one is archived, deleted or shut
 * down, so the cause names every case rather than guessing one.
 */
export function describeLossCause(lost: LossFacts): string {
  if (isCodexHostLoss(lost)) {
    return "Codex closed this conversation in its app-server. It does that after 30 idle minutes " +
      "with no client showing the conversation, and when it is archived, deleted or shut down";
  }
  return `the harness reported this session ended${lost.hook_reason ? ` (${lost.hook_reason})` : ""}`;
}

/** The same cause in a few words, for member lists. */
export function describeLossCauseShort(lost: LossFacts): string {
  return isCodexHostLoss(lost) ? "Codex closed the conversation" : "its session ended";
}

/** What happens next for a lost member, for operators. */
export const LOST_MEMBER_RECOVERY =
  "It rejoins when that conversation runs tt again, and messages to it wait until then.";

function isCodexHostLoss(lost: LossFacts): boolean {
  return lost.harness_name === "codex" && lost.process_kind === "shared_host";
}
