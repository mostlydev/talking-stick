import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveDataDir, type ResolveDataDirOptions } from "./config.js";
import { HARNESS_CLI_HARNESSES, type HarnessCliHarness } from "./harness-model.js";
import type { DerivedIdentity } from "./identity.js";
import { resolveContextPath } from "./path-resolution.js";
import {
  digestText,
  getManagedContent,
  recordManagedContent,
  recordManagedContentOffer
} from "./managed-content.js";

export type InstructionHarness =
  | HarnessCliHarness
  | "all";
export type InstructionScope = "effective" | "bundled" | "user" | "project";
export type EditableInstructionScope = "user" | "project";

export interface InstructionPaths {
  user: string;
  project: string;
}

export interface InstructionSource {
  scope: Exclude<InstructionScope, "effective">;
  path: string | null;
}

export interface ShowInstructionsResult {
  harness: InstructionHarness;
  scope: InstructionScope;
  text: string;
  sources: InstructionSource[];
  paths: InstructionPaths;
}

export interface EditInstructionsResult {
  scope: EditableInstructionScope;
  path: string;
  created: boolean;
  opened: boolean;
  editor: string | null;
}

export interface ResetInstructionsResult {
  scope: EditableInstructionScope;
  path: string;
  removed: boolean;
}

export interface UpdateInstructionsResult {
  scope: EditableInstructionScope;
  path: string;
  status: "missing" | "current" | "updated" | "update_available";
  message: string;
  offer: boolean;
}

export interface InstructionOptions extends ResolveDataDirOptions {
  contextPath?: string;
  identity?: DerivedIdentity;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  maxInstructionFileBytes?: number;
}

export const DEFAULT_MAX_INSTRUCTION_FILE_BYTES = 256 * 1024;

export const DEFAULT_INSTRUCTIONS_MARKDOWN = `# Talking Stick collaboration instructions

When this skill applies, coordinate until the shared task is complete:

1. Run \`tt join --json\`, then \`tt instructions show --json\` once. Check \`tt state --json\` for who is present and give peers a brief window to join before planning alone.
2. Keep exactly one \`tt wait --json\` long-poll running while agent work remains. The CLI saves the cursor and silently renews internal service waits in the same OS process, so silence does not exit. If your tool yields a running process handle, resume only that process; do not start another wait, narrate timer polls, or add a short \`--timeout\`.
3. Only \`status: "your_turn"\` with a \`guardian_pid\` authorizes shared edits. Messages and event wakes do not.
4. Send live messages with \`tt msg send\`; receive them through the same wait. Wait output is not ambient unless the harness surfaces the running process output.
5. When a wait exits, process its actionable result and start one successor if agent work remains. When only an operator or external signal remains, use \`tt standby --wake cmux --json\`; use \`tt wait --park\` only when a live process listener is useful. Do not poll with \`tt try\`, \`tt state\`, \`tt events\`, or \`tt msg recv\`.
6. Test before handoff. Release with a concise status, next action, artifacts, and verification.

Working agreement:

7. Plan first: debate adversarially in the room, challenge proposals, converge on a written plan, then implement. Prefer TDD/BDD when the behavior can be specified first.
8. Default roles when present — Claude: architecture, drafting, large-context synthesis. Codex: precise implementation. Grok: fast implementation and cross-checks. Reassign explicitly when the task warrants.
9. Review independently: reproduce peer claims and re-run tests yourself before agreeing. Every member has an independent voice and a veto.
10. Close or leave the room only after unanimous agreement and one full action-free cycle (each member takes a turn with nothing left to change or object to).
`;

export const EDITABLE_INSTRUCTIONS_TEMPLATE = `# Local Talking Stick instructions

<!-- Add only local overrides here. Bundled coordination instructions are loaded automatically. -->
`;

const LEGACY_DEFAULT_INSTRUCTION_DIGESTS = new Set([
  "fa303d636041cc8444c84b173090ab778d22342774fe11d384d62d96400139c6"
]);

export const INSTRUCTION_HARNESSES = [
  ...HARNESS_CLI_HARNESSES,
  "all"
] as const satisfies readonly InstructionHarness[];

export const HARNESS_ALIASES: Record<string, InstructionHarness> = {
  all: "all",
  base: "all",
  claude: "claude",
  "claude-code": "claude",
  antigravity: "antigravity",
  agy: "antigravity",
  codex: "codex",
  gemini: "gemini",
  grok: "grok",
  "grok-build": "grok",
  opencode: "opencode"
};

export function resolveInstructionPaths(
  options: InstructionOptions = {}
): InstructionPaths {
  const contextPath = options.contextPath ?? process.cwd();
  const workspaceRoot = resolveContextPath(contextPath).workspace_root;
  return {
    user: path.join(resolveDataDir(options), "instructions.md"),
    project: path.join(workspaceRoot, ".talking-stick", "instructions.md")
  };
}

export function showInstructions(input: {
  harness?: string;
  scope?: InstructionScope;
  options?: InstructionOptions;
} = {}): ShowInstructionsResult {
  const options = input.options ?? {};
  const harness = resolveInstructionHarness(input.harness, options.identity);
  const scope = input.scope ?? "effective";
  const paths = resolveInstructionPaths(options);
  const layers = readInstructionLayers(
    paths,
    options.maxInstructionFileBytes ?? DEFAULT_MAX_INSTRUCTION_FILE_BYTES
  );
  const selectedLayers = selectLayers(scope, layers);
  const text = joinInstructionTexts(
    selectedLayers.map((layer) => extractHarnessInstructions(layer.text, harness))
  );
  return {
    harness,
    scope,
    text,
    sources: selectedLayers.map((layer) => ({
      scope: layer.scope,
      path: layer.path
    })),
    paths
  };
}

export async function editInstructions(input: {
  scope?: EditableInstructionScope;
  options?: InstructionOptions;
} = {}): Promise<EditInstructionsResult> {
  const scope = input.scope ?? "user";
  const options = input.options ?? {};
  const paths = resolveInstructionPaths(options);
  const filePath = paths[scope];
  const created = ensureInstructionFile(filePath, options);
  const editor = chooseEditor(options);

  if (!editor) {
    return { scope, path: filePath, created, opened: false, editor: null };
  }

  await runEditor(editor, filePath);
  return { scope, path: filePath, created, opened: true, editor };
}

export function updateInstructions(input: {
  scopes?: EditableInstructionScope[];
  replaceEdited?: boolean;
  markOffers?: boolean;
  options?: InstructionOptions;
} = {}): UpdateInstructionsResult[] {
  const options = input.options ?? {};
  const paths = resolveInstructionPaths(options);
  const scopes = input.scopes ?? ["user", "project"];
  const desiredDigest = digestText(EDITABLE_INSTRUCTIONS_TEMPLATE);

  return scopes.map((scope) => {
    const filePath = paths[scope];
    if (!fs.existsSync(filePath)) {
      return {
        scope,
        path: filePath,
        status: "missing",
        message: "instructions file is not present",
        offer: false
      };
    }

    const text = fs.readFileSync(filePath, "utf8");
    const digest = digestText(text);
    const managed = getManagedContent(filePath, options);
    if (digest === desiredDigest) {
      recordManagedContent(filePath, "editable-instructions", digest, options);
      return {
        scope,
        path: filePath,
        status: "current",
        message: "local overrides template is current",
        offer: false
      };
    }

    const isUnedited =
      LEGACY_DEFAULT_INSTRUCTION_DIGESTS.has(digest) ||
      (managed?.kind === "editable-instructions" && managed.digest === digest);
    if (isUnedited || input.replaceEdited) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, EDITABLE_INSTRUCTIONS_TEMPLATE, "utf8");
      recordManagedContent(
        filePath,
        "editable-instructions",
        desiredDigest,
        options
      );
      return {
        scope,
        path: filePath,
        status: "updated",
        message: isUnedited
          ? "replaced an unedited generated default with the local-overrides template"
          : "replaced customized instructions at the operator's request",
        offer: false
      };
    }

    const offer = input.markOffers
      ? recordManagedContentOffer(
          filePath,
          desiredDigest,
          "editable-instructions",
          options
        )
      : true;
    return {
      scope,
      path: filePath,
      status: "update_available",
      message: `customized instructions were preserved; replace them with \`tt instructions update --${scope} --replace\``,
      offer
    };
  });
}

export function resetInstructions(input: {
  scope: EditableInstructionScope;
  options?: InstructionOptions;
}): ResetInstructionsResult {
  const paths = resolveInstructionPaths(input.options ?? {});
  const filePath = paths[input.scope];
  const removed = fs.existsSync(filePath);
  if (removed) {
    fs.rmSync(filePath, { force: true });
  }
  return { scope: input.scope, path: filePath, removed };
}

export function resolveInstructionHarness(
  explicitHarness: string | undefined,
  identity?: DerivedIdentity
): InstructionHarness {
  if (explicitHarness) {
    return normalizeInstructionHarness(explicitHarness);
  }

  const displayName = identity?.process_metadata.display_name ?? undefined;
  const fromDisplay = displayName ? HARNESS_ALIASES[normalizeKey(displayName)] : undefined;
  if (fromDisplay) {
    return fromDisplay;
  }

  const prefix = identity?.agent_id.split(":")[0];
  const fromPrefix = prefix ? HARNESS_ALIASES[normalizeKey(prefix)] : undefined;
  return fromPrefix ?? "all";
}

export function normalizeInstructionHarness(value: string): InstructionHarness {
  const normalized = HARNESS_ALIASES[normalizeKey(value)];
  if (!normalized) {
    throw new Error(
      `--harness must be one of claude, codex, antigravity, gemini, grok, opencode, all (got ${value}).`
    );
  }
  return normalized;
}

export function parseInstructionScope(value: string | undefined): InstructionScope {
  if (!value) {
    return "effective";
  }
  if (
    value === "effective" ||
    value === "bundled" ||
    value === "user" ||
    value === "project"
  ) {
    return value;
  }
  throw new Error(
    `--scope must be one of effective, bundled, user, project (got ${value}).`
  );
}

export function extractHarnessInstructions(
  markdown: string,
  harness: InstructionHarness
): string {
  const trimmed = markdown.trim();
  if (!trimmed || harness === "all") {
    return trimmed;
  }

  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const shared: string[] = [];
  const sections = new Map<InstructionHarness, string[]>();
  let current: InstructionHarness | null = null;
  let sawSection = false;

  for (const line of lines) {
    const header = parseHarnessHeader(line);
    if (header) {
      sawSection = true;
      current = header;
      if (!sections.has(current)) {
        sections.set(current, []);
      }
      sections.get(current)?.push(line);
      continue;
    }

    if (sawSection && isMarkdownH2Header(line)) {
      current = null;
      continue;
    }

    if (!sawSection) {
      shared.push(line);
      continue;
    }

    if (current) {
      sections.get(current)?.push(line);
    }
  }

  return joinInstructionTexts([
    shared.join("\n").trim(),
    sections.get(harness)?.join("\n").trim() ?? ""
  ]);
}

function readInstructionLayers(
  paths: InstructionPaths,
  maxInstructionFileBytes: number
): Array<{
  scope: Exclude<InstructionScope, "effective">;
  path: string | null;
  text: string;
}> {
  const layers: Array<{
    scope: Exclude<InstructionScope, "effective">;
    path: string | null;
    text: string;
  }> = [
    { scope: "bundled", path: null, text: DEFAULT_INSTRUCTIONS_MARKDOWN }
  ];

  for (const scope of ["user", "project"] as const) {
    const filePath = paths[scope];
    if (!fs.existsSync(filePath)) {
      continue;
    }
    const stat = fs.statSync(filePath);
    if (stat.size > maxInstructionFileBytes) {
      throw new Error(
        `${scope} instructions file is too large (${stat.size} bytes, max ${maxInstructionFileBytes}): ${filePath}`
      );
    }
    const text = fs.readFileSync(filePath, "utf8");
    layers.push({ scope, path: filePath, text });
  }

  return layers;
}

function selectLayers(
  scope: InstructionScope,
  layers: InstructionLayer[]
): InstructionLayer[] {
  if (scope === "effective") {
    return layers;
  }
  return layers.filter((layer) => layer.scope === scope);
}

type InstructionLayer = {
  scope: Exclude<InstructionScope, "effective">;
  path: string | null;
  text: string;
};

function joinInstructionTexts(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function ensureInstructionFile(
  filePath: string,
  options: InstructionOptions
): boolean {
  if (fs.existsSync(filePath)) {
    return false;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, EDITABLE_INSTRUCTIONS_TEMPLATE);
  recordManagedContent(
    filePath,
    "editable-instructions",
    digestText(EDITABLE_INSTRUCTIONS_TEMPLATE),
    options
  );
  return true;
}

function isMarkdownH2Header(line: string): boolean {
  return /^##\s+.+?\s*$/.test(line);
}

function parseHarnessHeader(line: string): InstructionHarness | null {
  const match = line.match(/^##\s+(.+?)\s*$/);
  if (!match) {
    return null;
  }
  const key = normalizeKey(match[1]);
  if (key.startsWith("claude")) return "claude";
  if (key.startsWith("codex")) return "codex";
  if (key.startsWith("antigravity") || key === "agy") return "antigravity";
  if (key.startsWith("gemini")) return "gemini";
  if (key.startsWith("grok")) return "grok";
  if (key.startsWith("opencode")) return "opencode";
  return null;
}

function chooseEditor(options: InstructionOptions): string | null {
  const env = options.env ?? process.env;
  const explicit = env.VISUAL?.trim() || env.EDITOR?.trim();
  if (explicit) {
    return explicit;
  }

  switch (options.platform ?? process.platform) {
    case "darwin":
      return "open -t";
    case "win32":
      return "notepad.exe";
    default:
      if (env.DISPLAY || env.WAYLAND_DISPLAY) {
        return "xdg-open";
      }
      return null;
  }
}

function runEditor(editor: string, filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(`${editor} ${shellQuote(filePath)}`, {
      stdio: "inherit",
      shell: true
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${editor} exited with code ${code}.`));
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function normalizeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
