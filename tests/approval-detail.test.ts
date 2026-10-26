import { expect, test } from "vitest";
import { approvalDetail, approvalSummary, safeDetail } from "../src/supervisor/approval-detail.js";

test("review: Arabic Letter Mark is escaped in full approval detail and summaries", () => {
  const command = "echo safe\u061c; hidden-direction";
  const detail = approvalDetail({ input: { command } })!;
  expect(JSON.parse(detail)).toEqual({ input: { command } });
  expect(detail).not.toContain("\u061c");
  expect(detail).toContain("\\u061c");
  expect(approvalSummary(command)).not.toContain("\u061c");
});

test("every format and default-ignorable character is escaped, and the detail parses back to the request", () => {
  // A tag letter (supplementary), a soft hyphen, a variation selector, a Hangul filler and a line separator.
  const command = "echo a\u{E0041}b­c️dㅤe f";
  const detail = approvalDetail({ input: { command } })!;
  expect(detail).toMatch(/^[\x20-\x7e\n]*$/);
  expect(JSON.parse(detail)).toEqual({ input: { command } });
  expect(approvalSummary(command)).toMatch(/^[\x20-\x7e]*$/);
});

test("escaping detail twice changes nothing, and ordinary text is kept as is", () => {
  const detail = approvalDetail({ input: { command: "echo café \u{1F600} ‮" } })!;
  expect(safeDetail(detail)).toBe(detail);
  expect(detail).toContain("café \u{1F600}");
  expect(approvalDetail({ input: "x".repeat(200 * 1024) })).toBeNull();
});
