import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveDataDir, type ResolveDataDirOptions } from "./config.js";
import type { DerivedIdentity } from "./identity.js";
import { resolveContextPath } from "./path-resolution.js";

export type InstructionHarness =
  | "claude"
  | "codex"
  | "gemini"
  | "grok"
  | "opencode"
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

export interface InstructionOptions extends ResolveDataDirOptions {
  contextPath?: string;
  identity?: DerivedIdentity;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  maxInstructionFileBytes?: number;
}

export const DEFAULT_MAX_INSTRUCTION_FILE_BYTES = 256 * 1024;

export const DEFAULT_INSTRUCTIONS_MARKDOWN = `# Talking Stick collaboration instructions

Keep using Talking Stick until the shared task is done. After releasing or handing off, re-enter the wait loop by default. Prefer continued action unless the task is complete or the operator explicitly redirects or stops the room. If a handoff, message, or operator instruction leaves review, release, or other work pending, use normal \`tt wait --json\`; do not park. Use \`tt wait --park --json\` only for passive standby when no task is pending and you are blocked on operator input or an external signal.

On freshly invoked multi-agent tasks, give peers a short window to join before deciding you are alone. Use a normal wait timeout or spend about a minute on read-only repo orientation while other harnesses appear.

Use phase names in handoffs when they clarify the work: draft, adversarial review, convergence, implementation, implementation review, test review, and release. These phases are vocabulary, not protocol state.

Claude and Codex are peers of comparable capability; neither outranks the other. Split work evenly between them rather than routing by stereotype, and have all models plan, implement, and evaluate together: any harness can draft, review, converge, implement, or release. Gemini and OpenCode start with conservative local guidance until project dogfood says otherwise.

For multi-agent design work, prefer independent read-only drafts first, then adversarial review and convergence. Do not impose a draft file structure on the workspace by default. If scratch draft files are useful, delete superseded pre-convergence drafts after the converged plan exists unless the operator asks to keep them.

Default to normal release handoffs. Use named assignment only when a specific member must go next because of unique context, credentials, capability, or direct operator routing.

## Claude

Take a full, even share of planning, implementation, and evaluation. Watch for scope creep and messy first-pass artifacts. Make the next phase explicit in the handoff.

## Codex

Take a full, even share of planning, implementation, and evaluation. Watch for over-indexing on mechanics when the operator still needs to decide direction. Make the next phase explicit in the handoff.

## Gemini

Use broad context review and exploration conservatively until the project has stronger Gemini-specific dogfood. Keep handoffs concrete and do not assume responsibility that the operator assigned to another harness.

## Grok

Use Grok Build as a first-class local coding harness. Keep coordination safety ahead of speed, rely on the native Grok skill and session hook when installed, and keep handoffs concrete when another harness is better positioned to implement or review.

## OpenCode

Use terminal-native local exploration and implementation conservatively until the project has stronger OpenCode-specific dogfood. Keep coordination safety ahead of speed.
`;

const HARNESS_ALIASES: Record<string, InstructionHarness> = {
  all: "all",
  base: "all",
  claude: "claude",
  "claude-code": "claude",
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
  const created = ensureInstructionFile(filePath);
  const editor = chooseEditor(options);

  if (!editor) {
    return { scope, path: filePath, created, opened: false, editor: null };
  }

  await runEditor(editor, filePath);
  return { scope, path: filePath, created, opened: true, editor };
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
      `--harness must be one of claude, codex, gemini, grok, opencode, all (got ${value}).`
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

function ensureInstructionFile(filePath: string): boolean {
  if (fs.existsSync(filePath)) {
    return false;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, DEFAULT_INSTRUCTIONS_MARKDOWN);
  return true;
}

function parseHarnessHeader(line: string): InstructionHarness | null {
  const match = line.match(/^##\s+(.+?)\s*$/);
  if (!match) {
    return null;
  }
  const key = normalizeKey(match[1]);
  if (key.startsWith("claude")) return "claude";
  if (key.startsWith("codex")) return "codex";
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
