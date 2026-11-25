import type { LostMember } from "./types.js";

type LossFacts = Pick<LostMember, "harness_name" | "process_kind" | "hook_reason">;
type LossState = Pick<LostMember, "harness_name" | "process_kind" | "process_liveness">;

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

/**
 * A conversation a Codex app-server closed while that app-server reads
 * alive, such as an idle thread, is dormant: the app-server may reopen it.
 * A running host does not prove it will, so messages still wait and a wake
 * is not counted as delivered. A gone or inconclusive reading is lost.
 */
export function isDormant(lost: LossState): boolean {
  return isCodexHostLoss(lost) && lost.process_liveness === "alive";
}

/** The member-list label: "dormant", or "lost, recoverable" otherwise. */
export function lostMemberLabel(lost: LossState): "dormant" | "lost, recoverable" {
  return isDormant(lost) ? "dormant" : "lost, recoverable";
}

/** What happens next for a dormant or lost member, for operators. */
export const LOST_MEMBER_RECOVERY =
  "Each rejoins when its conversation runs tt again, and messages to it wait until then.";

function isCodexHostLoss(lost: Pick<LostMember, "harness_name" | "process_kind">): boolean {
  return lost.harness_name === "codex" && lost.process_kind === "shared_host";
}
