// Kept dependency-free so `rooms prompt` can name the local human without
// loading identity detection.
export function sanitizeIdentityComponent(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "anon";
}
