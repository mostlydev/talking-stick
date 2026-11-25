import { HUMAN_CHAT_SESSION_KIND, type LostMember, type RoomMember } from "../types.js";

interface KickOptions { force: boolean; stop?: true; reason?: string }

/**
 * Resolves a /kick target among live members first, then among lost ones,
 * which a kick removes for good. An exact ID wins; otherwise a unique prefix.
 */
export function resolveChatKick(args: string, members: RoomMember[], selfId: string,
  lost: readonly LostMember[] = []): ({ target: RoomMember } | { lost: LostMember }) & KickOptions {
  const match = /^(?:(--force|--stop)\s+)?(@?\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
  if (!match || match[2].startsWith("--")) {
    throw new Error("Usage: /kick [--force | --stop] <agent> [reason]");
  }
  const selector = match[2].replace(/^@/, "").toLowerCase();
  if (!selector) throw new Error("Usage: /kick [--force | --stop] <agent> [reason]");
  const options: KickOptions = { force: Boolean(match[1]), ...(match[1] === "--stop" ? { stop: true as const } : {}),
    reason: match[3]?.trim() || undefined };
  const exact = members.find((member) => member.agent_id.toLowerCase() === selector);
  const matches = exact ? [exact] : members.filter((member) =>
    member.agent_id.toLowerCase().startsWith(selector) ||
    member.display_name?.toLowerCase().startsWith(selector));
  if (matches.length === 0) {
    const exactLost = lost.find((member) => member.agent_id.toLowerCase() === selector);
    const lostMatches = exactLost ? [exactLost] : lost.filter((member) => member.agent_id.toLowerCase().startsWith(selector));
    if (lostMatches.length === 1) return { lost: lostMatches[0], ...options };
    if (lostMatches.length > 1) throw new Error(`Ambiguous agent ${selector}: ${lostMatches.map((member) => member.agent_id).join(", ")}. Use a full agent id.`);
    throw new Error(`No room member matches ${selector}.`);
  }
  if (matches.length > 1) throw new Error(`Ambiguous agent ${selector}: ${matches.map((member) => member.agent_id).join(", ")}. Use a full agent id.`);
  const target = matches[0];
  if (target.agent_id === selfId || target.session_kind === HUMAN_CHAT_SESSION_KIND) {
    throw new Error("Chat consoles cannot be kicked here. Use /quit to leave your console.");
  }
  return { target, ...options };
}
