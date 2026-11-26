import { HUMAN_CHAT_SESSION_KIND, type LostMember, type RoomMember } from "../types.js";

interface KickOptions { force: boolean; stop?: true; reason?: string }

type KickCandidate = { target: RoomMember } | { lost: LostMember };

/**
 * Resolves a /kick target among live members and lost ones, which a kick
 * removes for good. An exact agent ID wins, live first, then lost. Otherwise
 * the prefix matches from both sets are pooled and must name one member.
 */
export function resolveChatKick(args: string, members: RoomMember[], selfId: string,
  lost: readonly LostMember[] = []): KickCandidate & KickOptions {
  const match = /^(?:(--force|--stop)\s+)?(@?\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
  if (!match || match[2].startsWith("--")) {
    throw new Error("Usage: /kick [--force | --stop] <agent> [reason]");
  }
  const selector = match[2].replace(/^@/, "").toLowerCase();
  if (!selector) throw new Error("Usage: /kick [--force | --stop] <agent> [reason]");
  const options: KickOptions = { force: Boolean(match[1]), ...(match[1] === "--stop" ? { stop: true as const } : {}),
    reason: match[3]?.trim() || undefined };
  const exactLive = members.find((member) => member.agent_id.toLowerCase() === selector);
  const exactLost = lost.find((member) => member.agent_id.toLowerCase() === selector);
  const candidates: KickCandidate[] = exactLive ? [{ target: exactLive }]
    : exactLost ? [{ lost: exactLost }]
      : [
        ...members.filter((member) =>
          member.agent_id.toLowerCase().startsWith(selector) ||
          member.display_name?.toLowerCase().startsWith(selector)).map((target) => ({ target })),
        ...lost.filter((member) => member.agent_id.toLowerCase().startsWith(selector)).map((member) => ({ lost: member }))
      ];
  if (candidates.length === 0) throw new Error(`No room member matches ${selector}.`);
  if (candidates.length > 1) {
    const ids = candidates.map((candidate) => "target" in candidate ? candidate.target.agent_id : candidate.lost.agent_id);
    throw new Error(`Ambiguous agent ${selector}: ${ids.join(", ")}. Use a full agent id.`);
  }
  const [only] = candidates;
  if ("lost" in only) return { lost: only.lost, ...options };
  if (only.target.agent_id === selfId || only.target.session_kind === HUMAN_CHAT_SESSION_KIND) {
    throw new Error("Chat consoles cannot be kicked here. Use /quit to leave your console.");
  }
  return { target: only.target, ...options };
}
