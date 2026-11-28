// A console is present while its terminal has not reported focus loss and the
// operator typed or used the mouse within this window. Two minutes is long
// enough to read a message that is already on screen, and short enough that a
// console left open does not mark later messages read.
export const CHAT_PRESENCE_MS = 2 * 60 * 1000;

export const FOCUS_REPORTING_ON = "\u001b[?1004h";
export const FOCUS_REPORTING_OFF = "\u001b[?1004l";

export interface ConsolePresence {
  /** null until the terminal reports focus. A key or click then counts as focus. */
  focused: boolean | null;
  lastInputAt: number | null;
}

export function noteConsoleInput(presence: ConsolePresence, now: number): void {
  presence.lastInputAt = now;
  if (presence.focused === false) presence.focused = true;
}

export function noteConsoleFocus(presence: ConsolePresence, focused: boolean): void {
  presence.focused = focused;
}

export function consoleIsPresent(presence: ConsolePresence, now: number, ttl = CHAT_PRESENCE_MS): boolean {
  if (presence.focused === false) return false;
  if (presence.lastInputAt === null) return false;
  return now - presence.lastInputAt <= ttl;
}
