import type { Harness, HarnessAdapter } from "../adapter.js";

// The harness adapters this build provides. Each is added in its own slice
// once its headless protocol is proven (docs/supervisor.md); until then a
// worker for that harness is held with start_failed rather than started.
export function builtinAdapters(): Partial<Record<Harness, HarnessAdapter>> {
  return {};
}
