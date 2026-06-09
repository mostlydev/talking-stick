import { describe, expect, test } from "vitest";
import {
  parseCommand,
  parseOptionalInteger,
  type ParsedCommand
} from "../src/cli/parser.js";

describe("parseCommand", () => {
  test("known boolean flags do not consume following positionals", () => {
    const parsed = parseCommand(["state", "--json", "/repo"]);

    expect(parsed.options.get("json")).toBe(true);
    expect(parsed.positionals).toEqual(["/repo"]);
  });

  test("boolean flags in subcommands leave message text positional", () => {
    const parsed = parseCommand([
      "msg",
      "send",
      "codex:test",
      "--interrupt",
      "hello"
    ]);

    expect(parsed.options.get("interrupt")).toBe(true);
    expect(parsed.positionals).toEqual(["send", "codex:test", "hello"]);
  });
});

describe("parseOptionalInteger", () => {
  test("rejects tokens with trailing garbage", () => {
    const parsed: ParsedCommand = {
      name: "events",
      positionals: [],
      options: new Map([["after", "100ms"]])
    };

    expect(() => parseOptionalInteger(parsed, "after")).toThrow(
      /--after must be an integer/
    );
  });
});
