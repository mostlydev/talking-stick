// The full native request behind an approval, kept whole so a human can read
// exactly what they would allow. A summary is only a short line of it.

// Below the 256 KiB protocol line cap, so a request too large to review is refused, not an overflow.
export const APPROVAL_DETAIL_MAX_BYTES = 128 * 1024;

// Anything that can hide, reorder or control text on a terminal: C1 and DEL, every format
// character (bidi marks, overrides and isolates among them), line and paragraph separators, and
// default-ignorable code points. JSON escapes C0 controls itself, so the detail keeps its newlines.
const INVISIBLE = /[\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;
const CONTROL = /[\u0000-\u001f]/g;

// A supplementary code point escapes as its surrogate pair, so the JSON still parses to the original.
const escape = (match: string) => Array.from({ length: match.length }, (_, index) =>
  `\\u${match.charCodeAt(index).toString(16).padStart(4, "0")}`).join("");

/** Text for one line of display, with controls and invisible characters escaped. */
export function displayText(text: string, max = 350): string {
  return text.replace(CONTROL, escape).replace(INVISIBLE, escape).slice(0, max);
}

/** One line of text for a summary. */
export function approvalSummary(text: string): string {
  return displayText(text, 350);
}

/** Escapes what JSON leaves visible-unsafe; text already escaped is unchanged. */
export function safeDetail(json: string): string {
  return json.replace(INVISIBLE, escape);
}

/** The request as indented JSON with every invisible character escaped, or null when too large to review. */
export function approvalDetail(request: unknown): string | null {
  const text = safeDetail(JSON.stringify(request, null, 2));
  return Buffer.byteLength(text) > APPROVAL_DETAIL_MAX_BYTES ? null : text;
}
