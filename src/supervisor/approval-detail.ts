// The full native request behind an approval, kept whole so a human can read
// exactly what they would allow. A summary is only a short line of it.

// Below the 256 KiB protocol line cap, so a request too large to review is refused, not an overflow.
export const APPROVAL_DETAIL_MAX_BYTES = 128 * 1024;

// JSON escapes C0 controls itself; these can still reorder or hide text on a terminal.
const UNSAFE = /[\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
const CONTROL = /[\u0000-\u001f]/g;

const escape = (char: string) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;

/** One line of text for a summary, with controls and invisible characters escaped. */
export function approvalSummary(text: string, max = 350): string {
  return text.replace(CONTROL, escape).replace(UNSAFE, escape).slice(0, max);
}

/** The request as indented JSON with every invisible character escaped, or null when too large to review. */
export function approvalDetail(request: unknown): string | null {
  const text = JSON.stringify(request, null, 2).replace(UNSAFE, escape);
  return Buffer.byteLength(text) > APPROVAL_DETAIL_MAX_BYTES ? null : text;
}
