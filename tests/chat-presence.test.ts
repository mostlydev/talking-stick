import { describe, expect, test } from "vitest";
import {
  CHAT_PRESENCE_MS,
  consoleIsPresent,
  noteConsoleFocus,
  noteConsoleInput,
  type ConsolePresence
} from "../src/cli/chat-presence.js";

function presence(): ConsolePresence {
  return { focused: null, lastInputAt: null };
}

describe("console presence", () => {
  test("input with no focus report counts as present", () => {
    const state = presence();
    noteConsoleInput(state, 1_000);
    expect(consoleIsPresent(state, 1_000)).toBe(true);
  });

  test("a quiet console is not present, and presence expires", () => {
    const state = presence();
    expect(consoleIsPresent(state, 1_000)).toBe(false);
    noteConsoleInput(state, 1_000);
    expect(consoleIsPresent(state, 1_000 + CHAT_PRESENCE_MS)).toBe(true);
    expect(consoleIsPresent(state, 1_001 + CHAT_PRESENCE_MS)).toBe(false);
  });

  test("focus loss ends presence until the next input", () => {
    const state = presence();
    noteConsoleInput(state, 1_000);
    noteConsoleFocus(state, false);
    expect(consoleIsPresent(state, 1_000)).toBe(false);
    noteConsoleInput(state, 2_000);
    expect(state.focused).toBe(true);
    expect(consoleIsPresent(state, 2_000)).toBe(true);
  });

  test("focus gain without input does not make the console present", () => {
    const state = presence();
    noteConsoleFocus(state, true);
    expect(consoleIsPresent(state, 1_000)).toBe(false);
  });
});
