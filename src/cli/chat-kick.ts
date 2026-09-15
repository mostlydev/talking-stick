import { HUMAN_CHAT_SESSION_KIND, type RoomMember } from "../types.js";

export function resolveChatKick(args: string, members: RoomMember[], selfId: string): {
  target: RoomMember;
  force: boolean;
  reason?: string;
} {
  const match = /^(?:(--force)\s+)?(@?\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
  if (!match || match[2].startsWith("--")) {
    throw new Error("Usage: /kick [--force] <agent> [reason]");
  }
  const selector = match[2].replace(/^@/, "").toLowerCase();
  if (!selector) throw new Error("Usage: /kick [--force] <agent> [reason]");
  const exact = members.find((member) => member.agent_id.toLowerCase() === selector);
  const matches = exact ? [exact] : members.filter((member) =>
    member.agent_id.toLowerCase().startsWith(selector) ||
    member.display_name?.toLowerCase().startsWith(selector));
  if (matches.length === 0) throw new Error(`No room member matches ${selector}.`);
  if (matches.length > 1) throw new Error(`Ambiguous agent ${selector}: ${matches.map((member) => member.agent_id).join(", ")}. Use a full agent id.`);
  const target = matches[0];
  if (target.agent_id === selfId || target.session_kind === HUMAN_CHAT_SESSION_KIND) {
    throw new Error("Chat consoles cannot be kicked here. Use /quit to leave your console.");
  }
  return { target, force: Boolean(match[1]), reason: match[3]?.trim() || undefined };
}
