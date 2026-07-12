import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDataDir } from "./config.js";
import {
  SUPPORTED_HARNESSES,
  resolveHarnessConfigDir,
  skipAction,
  type HarnessId,
  type InstallOptions,
  type InstallResult,
  type InstallStatus
} from "./install.js";
import type { AuditLog, AuditReason } from "./install-audit.js";
import type { CleanupResult } from "./install-audit.js";
import {
  DEFAULT_SKILL_NAME,
  resolveBundledSkillPath,
  type SkillSyncResult
} from "./skill-install.js";

export const DEFAULT_SKILLER_MIN_VERSION = "0.1.0";

type SkillerOperation =
  | "install"
  | "uninstall"
  | "cleanup-duplicates"
  | "sync";
type FileSkillHarness = Exclude<HarnessId, "gemini">;

interface SkillerAvailability {
  ok: boolean;
  path?: string;
  version?: string;
  required?: boolean;
  reason?: string;
}

interface SkillerRunOptions extends InstallOptions {
  harnesses?: readonly HarnessId[] | "all";
  link?: boolean;
  removeShared?: boolean;
  removeAll?: boolean;
  dryRun?: boolean;
  sourcePath?: string;
  reason?: AuditReason;
  packageVersionFrom?: string;
  packageVersionTo?: string;
  audit?: AuditLog;
}

interface SkillerPlan {
  schema?: string;
  operation?: string;
  sources?: SkillerSource[];
  actions?: SkillerAction[];
}

interface SkillerSource {
  id?: string;
  local_cache_path?: string;
  source_realpath?: string;
}

interface SkillerAction {
  id?: string;
  action?: string;
  status?: string;
  reason?: string;
  error?: string;
  source_id?: string;
  target?: {
    id?: string;
    kind?: string;
    path?: string;
    requested_targets?: string[];
    readers?: string[];
  };
  skill?: {
    requested_targets?: string[];
  };
  requested_mode?: string;
  effective_mode?: string;
  mode?: {
    requested?: string;
    effective?: string;
  };
  planned_writes?: Array<{ kind?: string; path?: string }>;
  writes?: Array<{ kind?: string; path?: string }>;
}

interface ChildResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const FILE_SKILL_HARNESSES: FileSkillHarness[] = SUPPORTED_HARNESSES.filter(
  (harness): harness is FileSkillHarness => harness !== "gemini"
);

export function resolveSkiller(
  options: InstallOptions = {}
): SkillerAvailability {
  const env = effectiveEnv(options);
  const required =
    env.TALKING_STICK_USE_SKILLER === "1" ||
    env.TALKING_STICK_REQUIRE_SKILLER === "1";

  if (env.TALKING_STICK_DISABLE_SKILLER?.trim()) {
    return {
      ok: false,
      required,
      reason: "disabled by TALKING_STICK_DISABLE_SKILLER"
    };
  }

  const binary = findSkillerBinary(env, options);
  if (!binary) {
    return { ok: false, required, reason: "skiller binary not found" };
  }

  const version = readSkillerVersion(binary, env);
  if (!version.ok) {
    return {
      ok: false,
      required,
      reason: version.reason
    };
  }

  const minimum =
    env.TALKING_STICK_SKILLER_MIN_VERSION ??
    env.SKILLER_MIN_VERSION ??
    DEFAULT_SKILLER_MIN_VERSION;
  const comparison = compareVersions(version.version, minimum);
  if (comparison == null || comparison < 0) {
    return {
      ok: false,
      required,
      reason: `skiller ${version.version} is older than required ${minimum}`
    };
  }

  return {
    ok: true,
    required,
    path: binary,
    version: version.version
  };
}

export async function runSkillerInstall(
  options: SkillerRunOptions
): Promise<InstallResult[] | null> {
  const result = await runSkiller("install", options);
  return result ? skillerActionsToInstallResults(result) : null;
}

export async function runSkillerUninstall(
  options: SkillerRunOptions
): Promise<InstallResult[] | null> {
  const result = await runSkiller("uninstall", options);
  return result ? skillerActionsToInstallResults(result) : null;
}

export async function runSkillerCleanupDuplicates(
  options: SkillerRunOptions
): Promise<CleanupResult[] | null> {
  const result = await runSkiller("cleanup-duplicates", options);
  if (!result) return null;

  const cleanups = skillerActionsToCleanupResults(result);
  appendSkillerCleanupAudits(options, cleanups, result.actions ?? []);
  return cleanups;
}

export async function runSkillerSyncInstalledSkills(
  options: SkillerRunOptions = {}
): Promise<SkillSyncResult | null> {
  const result = await runSkiller("sync", {
    harnesses: "all",
    ...options
  });
  if (!result) return null;

  const sourcePath = resolveBundledSkillPath(options);
  return {
    sourcePath,
    sourceDigest: "",
    targets: (result.actions ?? []).map((action) => ({
      harness: harnessFromAction(action) as Exclude<HarnessId, "gemini">,
      targetPath: action.target?.path ?? "",
      status: skillSyncStatus(action),
      message: skillerActionMessage(action)
    }))
  };
}

export async function runSkillerDryRun(
  operation: SkillerOperation,
  options: SkillerRunOptions
): Promise<string[] | null> {
  const result = await runSkiller(operation, { ...options, dryRun: true });
  return result ? formatSkillerPlanLines(result) : null;
}

async function runSkiller(
  operation: SkillerOperation,
  options: SkillerRunOptions
): Promise<SkillerPlan | null> {
  const availability = resolveSkiller(options);
  if (!availability.ok) {
    if (availability.required) {
      throw new Error(`skiller unavailable: ${availability.reason}`);
    }
    return null;
  }

  const targets = skillerTargets(options);
  if (targets.length === 0) {
    return null;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-skiller-"));
  const manifestPath = path.join(tempDir, "skiller.toml");
  try {
    fs.writeFileSync(manifestPath, renderManifest(targets, options), "utf8");
    const args = skillerArgs(operation, manifestPath, options);
    const child = await runChild(availability.path!, args, effectiveEnv(options));
    const parsed = parseJson(child.stdout, `${availability.path} ${args.join(" ")}`);
    if (!isSkillerPlan(parsed)) {
      throw new Error("skiller returned unexpected JSON");
    }
    if (child.exitCode !== 0 && !hasActionLevelFailure(parsed)) {
      const detail = child.stderr.trim() || `exit code ${child.exitCode}`;
      throw new Error(`skiller ${operation} failed: ${detail}`);
    }
    return parsed;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function skillerArgs(
  operation: SkillerOperation,
  manifestPath: string,
  options: SkillerRunOptions
): string[] {
  const args = [
    operation,
    "--manifest",
    manifestPath,
    "--json",
    "--home",
    resolveHome(options),
    "--state-dir",
    skillerStateDir(options),
    "--namespace",
    "mostlydev"
  ];
  if (options.dryRun) {
    args.push("--dry-run");
  }
  if ((operation === "uninstall" || operation === "sync") && options.removeShared) {
    args.push("--shared");
  }
  if ((operation === "uninstall" || operation === "sync") && options.removeAll) {
    args.push("--all");
  }
  return args;
}

function renderManifest(targets: string[], options: SkillerRunOptions): string {
  const mode = options.link === false ? "copy" : "link";
  const sourcePath = fs.realpathSync(resolveBundledSkillPath(options));
  const lines = [
    'schema = "skiller-install.v1"',
    'owner = "talking-stick"',
    'namespace = "mostlydev"',
    `version = ${tomlString(readLocalPackageVersion())}`,
    `default_mode = ${tomlString(mode)}`,
    "",
    "[[skills]]",
    `name = ${tomlString(DEFAULT_SKILL_NAME)}`,
    'canonical_id = "mostlydev:talking-stick"',
    `install_slug = ${tomlString(DEFAULT_SKILL_NAME)}`,
    `source = ${tomlString(sourcePath)}`,
    `targets = [${targets.map(tomlString).join(", ")}]`,
    `mode = ${tomlString(mode)}`,
    ""
  ];
  return lines.join("\n");
}

function skillerTargets(options: SkillerRunOptions): string[] {
  const harnesses =
    options.harnesses === "all" ? FILE_SKILL_HARNESSES : options.harnesses ?? FILE_SKILL_HARNESSES;
  const targets = harnesses
    .filter((harness): harness is FileSkillHarness => harness !== "gemini")
    .filter((harness) => !shouldSkipSkillerHarness(harness, options))
    .map(skillerTargetForHarness);
  if (options.removeShared && targets.length === 0) {
    targets.push("agents");
  }
  return Array.from(new Set(targets));
}

function shouldSkipSkillerHarness(
  harness: FileSkillHarness,
  options: SkillerRunOptions
): boolean {
  if (!options.skipMissing) return false;
  if (harness !== "claude-code") return false;

  const harnessRoot = resolveHarnessConfigDir(harness, options);
  const pathExists = options.pathExists ?? fs.existsSync;
  return !pathExists(harnessRoot);
}

function skillerTargetForHarness(harness: FileSkillHarness): string {
  return harness === "claude-code" ? "claude-code" : harness;
}

function formatSkillerPlanLines(plan: SkillerPlan): string[] {
  const sources = new Map((plan.sources ?? []).map((source) => [source.id, source]));
  const lines: string[] = [];
  for (const action of plan.actions ?? []) {
    const harness = harnessFromAction(action);
    const targetPath = action.target?.path;
    const actionName = action.action ?? "";
    const source = action.source_id ? sources.get(action.source_id) : undefined;
    const sourcePath = source?.source_realpath ?? source?.local_cache_path;

    if (actionName === "install-link" && sourcePath && targetPath) {
      lines.push(`[${harness}] link ${sourcePath} -> ${targetPath}`);
    } else if (actionName === "install-copy" && sourcePath && targetPath) {
      lines.push(`[${harness}] copy ${sourcePath} -> ${targetPath}`);
    } else if (actionName === "refresh" && targetPath) {
      lines.push(`[${harness}] refresh ${targetPath}`);
    } else if (actionName === "remove-owned" && targetPath) {
      lines.push(`[${harness}] remove ${targetPath}`);
    } else if (actionName === "remove-duplicate" && targetPath) {
      lines.push(
        `[${harness}] remove duplicate skill symlink ${targetPath} if it points at bundled skill`
      );
    } else if (actionName === "block-conflict" || action.status === "blocked") {
      lines.push(`[${harness}] blocked: ${action.reason ?? "conflict"}`);
    }
  }
  return lines;
}

function skillerActionsToInstallResults(plan: SkillerPlan): InstallResult[] {
  return (plan.actions ?? []).map((action) => {
    const harness = harnessFromAction(action);
    const status = installStatusForAction(action);
    const message = skillerActionMessage(action);
    return {
      harness,
      ok: status !== "failed",
      action: skipAction(harness, message),
      status,
      message,
      skipped: status === "skipped" || status === "already_present" || status === "already_absent"
    };
  });
}

function skillerActionsToCleanupResults(plan: SkillerPlan): CleanupResult[] {
  return (plan.actions ?? []).map((action) => ({
    harness: harnessFromAction(action),
    action: cleanupActionForSkillerAction(action),
    message: skillerActionMessage(action),
    target_type: "skill" as const
  }));
}

function appendSkillerCleanupAudits(
  options: SkillerRunOptions,
  cleanups: CleanupResult[],
  actions: SkillerAction[]
): void {
  if (!options.audit || !options.reason) return;

  cleanups.forEach((cleanup, index) => {
    const action = actions[index];
    options.audit?.append({
      reason: options.reason!,
      package_version_from: options.packageVersionFrom,
      package_version_to: options.packageVersionTo,
      harness: cleanup.harness,
      target_type: "skill",
      config_path: action?.target?.path,
      action: cleanup.action,
      target_name: DEFAULT_SKILL_NAME,
      detail: cleanup.message
    });
  });
}

function installStatusForAction(action: SkillerAction): InstallStatus {
  if (
    action.status === "failed" ||
    action.status === "blocked" ||
    action.status === "partially-satisfied"
  ) {
    return "failed";
  }
  if (action.status === "installed") return "added";
  if (action.status === "updated") return "updated";
  if (action.status === "removed") return "removed";
  if (action.status === "skipped") {
    if (action.action === "skip-uninstall") {
      return action.reason?.includes("shared target requires --shared or --all")
        ? "skipped"
        : "already_absent";
    }
    if (action.action === "no-op" || action.action === "adopt-existing") {
      return "already_present";
    }
    return "skipped";
  }
  if (action.action === "satisfied-by-foreign") return "skipped";
  return "ok";
}

function cleanupActionForSkillerAction(
  action: SkillerAction
): CleanupResult["action"] {
  if (action.status === "removed") return "removed";
  if (
    action.status === "failed" ||
    action.status === "blocked" ||
    action.status === "partially-satisfied"
  ) {
    return "failed";
  }
  if (action.reason === "duplicate not present") return "absent";
  if (action.reason?.includes("preserved")) return "preserved";
  return "skipped";
}

function skillSyncStatus(action: SkillerAction): SkillSyncResult["targets"][number]["status"] {
  if (action.status === "installed" || action.status === "updated") return "updated";
  if (action.status === "failed" || action.status === "blocked") return "failed";
  if (action.status === "skipped") return "current";
  return "current";
}

function skillerActionMessage(action: SkillerAction): string {
  const targetPath = action.target?.path;
  const detail = action.error ?? action.reason;
  const prefix = action.action ?? "skiller";
  if (detail && targetPath) return `${prefix}: ${detail} (${targetPath})`;
  if (detail) return `${prefix}: ${detail}`;
  if (targetPath) return `${prefix}: ${targetPath}`;
  return prefix;
}

function harnessFromAction(action: SkillerAction): HarnessId {
  const candidates = [
    ...(action.skill?.requested_targets ?? []),
    ...(action.target?.requested_targets ?? []),
    action.target?.id,
    ...(action.target?.readers ?? [])
  ].filter(Boolean) as string[];

  for (const value of candidates) {
    const harness = normalizeHarness(value);
    if (harness) return harness;
  }
  return "antigravity";
}

function normalizeHarness(value: string): HarnessId | null {
  if (value === "agents") return "antigravity";
  if (value.endsWith("-duplicate")) {
    return normalizeHarness(value.slice(0, -"-duplicate".length));
  }
  return SUPPORTED_HARNESSES.includes(value as HarnessId)
    ? (value as HarnessId)
    : null;
}

function hasActionLevelFailure(plan: SkillerPlan): boolean {
  return (plan.actions ?? []).some(
    (action) =>
      action.status === "failed" ||
      action.status === "blocked" ||
      action.status === "partially-satisfied"
  );
}

function isSkillerPlan(value: unknown): value is SkillerPlan {
  return typeof value === "object" && value !== null && Array.isArray((value as SkillerPlan).actions);
}

function parseJson(raw: string, context: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${context} returned invalid JSON`);
  }
}

function runChild(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function findSkillerBinary(
  env: NodeJS.ProcessEnv,
  options: InstallOptions
): string | null {
  const explicit = env.SKILLER_BIN?.trim();
  if (explicit && isExecutable(explicit)) return explicit;

  const which = options.which?.("skiller");
  if (which && isExecutable(which)) return which;

  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of executableNames()) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }

  const local = path.join(resolveHome(options), ".local", "bin", executableNames()[0]);
  return isExecutable(local) ? local : null;
}

function readSkillerVersion(
  binary: string,
  env: NodeJS.ProcessEnv
): { ok: true; version: string } | { ok: false; reason: string } {
  const child = spawnSync(binary, ["version", "--json"], {
    env,
    encoding: "utf8",
    shell: false
  });
  if (child.status !== 0) {
    return {
      ok: false,
      reason: `failed to run ${binary} version --json`
    };
  }
  try {
    const parsed = JSON.parse(child.stdout) as { version?: unknown };
    if (typeof parsed.version !== "string" || parsed.version.trim() === "") {
      return { ok: false, reason: "skiller version JSON has no version" };
    }
    return { ok: true, version: parsed.version };
  } catch {
    return { ok: false, reason: "skiller version JSON is invalid" };
  }
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableNames(): string[] {
  return process.platform === "win32" ? ["skiller.exe", "skiller"] : ["skiller"];
}

function compareVersions(left: string, right: string): number | null {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] > b[index]) return 1;
    if (a[index] < b[index]) return -1;
  }
  return 0;
}

function parseVersion(value: string): [number, number, number] | null {
  const match = value.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return [
    Number(match[1]),
    Number(match[2] ?? 0),
    Number(match[3] ?? 0)
  ];
}

function skillerStateDir(options: InstallOptions): string {
  return path.join(
    resolveDataDir({
      env: effectiveEnv(options),
      platform: options.platform,
      homeDir: resolveHome(options)
    }),
    "skiller"
  );
}

function resolveHome(options: InstallOptions): string {
  const env = effectiveEnv(options);
  return options.homeDir ?? env.HOME ?? os.homedir();
}

function effectiveEnv(options: InstallOptions): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(options.env ?? {})
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function readLocalPackageVersion(): string {
  const root = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
  if (!root) return "unknown";
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8")
    ) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version
      : "unknown";
  } catch {
    return "unknown";
  }
}

function findPackageRoot(startPath: string): string | null {
  let current = startPath;
  while (true) {
    if (fs.existsSync(path.join(current, "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
