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

  test("leading global boolean flags do not become the command name", () => {
    const parsed = parseCommand(["--json", "wait", "--help"]);

    expect(parsed.name).toBe("wait");
    expect(parsed.options.get("json")).toBe(true);
    expect(parsed.options.get("help")).toBe(true);
  });

  test("leading global value options preserve the following command", () => {
    const parsed = parseCommand([
      "--agent",
      "human:helper",
      "wait",
      "/repo",
      "--help"
    ]);

    expect(parsed.name).toBe("wait");
    expect(parsed.options.get("agent")).toBe("human:helper");
    expect(parsed.options.get("help")).toBe(true);
    expect(parsed.positionals).toEqual(["/repo"]);
  });

  test("-h is normalized as command help without becoming a positional", () => {
    const parsed = parseCommand(["wait", "/repo", "-h"]);

    expect(parsed.name).toBe("wait");
    expect(parsed.options.get("help")).toBe(true);
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

  test("literal help remains message text when it is not a help flag", () => {
    const parsed = parseCommand(["msg", "send", "room", "help"]);

    expect(parsed.name).toBe("msg");
    expect(parsed.options.has("help")).toBe(false);
    expect(parsed.positionals).toEqual(["send", "room", "help"]);
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
