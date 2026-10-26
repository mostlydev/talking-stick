import type { Harness, HarnessAdapter } from "../adapter.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { GrokAdapter } from "./grok.js";

// The harness adapters this build provides. Grok can start a fresh session;
// its prompt, resume, interrupt and approvals stay false until each is proven
// (docs/supervisor.md). A harness with no adapter is held start_failed.
export function builtinAdapters(): Partial<Record<Harness, HarnessAdapter>> {
  return { claude: new ClaudeAdapter(), codex: new CodexAdapter(), grok: new GrokAdapter() };
}
