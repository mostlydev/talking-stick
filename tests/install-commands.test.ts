import { afterEach, describe, expect, test, vi } from "vitest";
import {
  printInstructionHint,
  reportCleanupResults
} from "../src/cli/install-commands.js";
import type { InstallResult } from "../src/install.js";
import type { RemoveStaleMcpResult } from "../src/install-migration.js";

function captureStdout(): { lines: () => string[] } {
  const written: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  return { lines: () => written.join("").split("\n").filter(Boolean) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reportCleanupResults", () => {
  test("stays silent for absent and skipped cleanup results", () => {
    const stdout = captureStdout();
    const results: RemoveStaleMcpResult[] = [
      {
        harness: "claude-code",
        action: "absent",
        message: "MCP server 'talking-stick' is not registered."
      },
      {
        harness: "grok",
        action: "skipped",
        message: "legacy Talking Stick cleanup is not applicable for grok"
      }
    ];

    reportCleanupResults(results, "install");

    expect(stdout.lines()).toEqual([]);
  });

  test("still reports removed, preserved, and failed cleanup results", () => {
    const stdout = captureStdout();
    const results: RemoveStaleMcpResult[] = [
      {
        harness: "codex",
        action: "removed",
        message: "Removed MCP server 'talking-stick'."
      },
      {
        harness: "opencode",
        action: "preserved",
        message: "Entry differs from the legacy command; left in place."
      },
      {
        harness: "gemini",
        action: "failed",
        message: "could not rewrite settings"
      }
    ];

    expect(() => reportCleanupResults(results, "install")).toThrow(
      /install completed with cleanup failures/
    );
    expect(stdout.lines()).toEqual([
      "[codex] mcp-cleanup removed: Removed MCP server 'talking-stick'.",
      "[opencode] mcp-cleanup preserved: Entry differs from the legacy command; left in place.",
      "[gemini] mcp-cleanup failed: could not rewrite settings"
    ]);
  });
});

describe("printInstructionHint", () => {
  const result = (status: InstallResult["status"]): InstallResult => ({
    harness: "claude-code",
    ok: status !== "failed",
    action: {
      kind: "skip",
      harness: "claude-code",
      description: "test",
      message: "test"
    },
    status,
    message: "test"
  });

  test("stays silent when every harness is already installed", () => {
    const stdout = captureStdout();

    printInstructionHint([result("already_present"), result("already_absent")]);

    expect(stdout.lines()).toEqual([]);
  });

  test("prints when an install actually changed something", () => {
    const stdout = captureStdout();

    printInstructionHint([result("already_present"), result("added")]);

    expect(stdout.lines()).toEqual([
      "Customize collaboration instructions with: tt instructions edit"
    ]);
  });
});
