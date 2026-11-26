import type { PromptState } from "./state.js";

export const DEFAULT_PROMPT_FORMAT = "#{room} {members}{holder: ▸}{blockers: !}{unread: @}";

/**
 * Fills a format. `{name}` is replaced by the value. `{name:prefix}` adds the
 * prefix and the value only when the value is non-empty and non-zero, so a
 * quiet room stays short: `#shrooms 4`, then `#shrooms 4 ▸claude !1 @2`.
 */
export function formatPrompt(state: PromptState, format = DEFAULT_PROMPT_FORMAT): string {
  const values: Record<string, string | number | null> = {
    room: state.room,
    path: state.room_path,
    members: state.members,
    names: state.names.join(" "),
    holder: state.holder,
    blockers: state.blockers,
    unread: state.unread
  };
  return format.replace(/\{([a-z]+)(?::([^}]*))?\}/g, (whole, name: string, prefix: string | undefined) => {
    if (!(name in values)) return whole;
    const value = values[name];
    if (prefix === undefined) return value === null ? "" : String(value);
    return value === null || value === "" || value === 0 ? "" : `${prefix}${value}`;
  });
}
