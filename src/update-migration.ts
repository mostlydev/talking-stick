import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDataDir, type ResolveDataDirOptions } from "./config.js";
import {
  FileAuditLog,
  defaultAuditLogPath,
  type AuditLog,
  type AuditReason
} from "./install-audit.js";
import {
  removeStaleMcpRegistrations,
  type RemoveStaleMcpResult
} from "./install-migration.js";
import { removeDuplicateSkillInstalls } from "./skill-install.js";
import type { HarnessId, InstallOptions } from "./install.js";

export const UPDATE_MIGRATION_STATE_FILE = "update-migrations-state.json";

export interface UpdateMigrationState {
  mcp_cleanup_version?: string;
  updated_at?: string;
}

export interface StaleMcpCleanupOptions {
  harnesses?: HarnessId[] | "all";
  reason: AuditReason;
  packageVersionFrom?: string;
  packageVersionTo?: string;
  packageVersion?: string;
  dataDir?: string;
  audit?: AuditLog;
  installOptions?: InstallOptions;
  updateState?: boolean;
}

export interface StaleMcpCleanupRun {
  status: "ran";
  packageVersionFrom?: string;
  packageVersionTo: string;
  statePath: string;
  auditPath: string;
  results: RemoveStaleMcpResult[];
}

export interface FirstRunMcpMigrationSkipped {
  status: "current";
  packageVersion: string;
  statePath: string;
  auditPath: string;
  results: [];
}

export type FirstRunMcpMigrationRun =
  | StaleMcpCleanupRun
  | FirstRunMcpMigrationSkipped;

export async function runStaleMcpCleanup(
  options: StaleMcpCleanupOptions
): Promise<StaleMcpCleanupRun> {
  const packageVersionTo =
    options.packageVersionTo ?? options.packageVersion ?? readPackageVersion();
  const dataDir = options.dataDir ?? resolveMigrationDataDir(options.installOptions);
  const statePath = resolveUpdateMigrationStatePath(dataDir);
  const auditPath = defaultAuditLogPath(dataDir);
  const audit = options.audit ?? new FileAuditLog(auditPath);

  const mcpResults = await removeStaleMcpRegistrations({
    harnesses: options.harnesses ?? "all",
    reason: options.reason,
    packageVersionFrom: options.packageVersionFrom,
    packageVersionTo,
    audit,
    installOptions: options.installOptions
  });
  const skillResults = removeDuplicateSkillInstalls({
    harnesses: options.harnesses ?? "all",
    reason: options.reason,
    packageVersionFrom: options.packageVersionFrom,
    packageVersionTo,
    audit,
    ...(options.installOptions ?? {})
  });
  const results = [...mcpResults, ...skillResults];

  if (options.updateState !== false && !results.some((result) => result.action === "failed")) {
    writeUpdateMigrationState(statePath, {
      mcp_cleanup_version: packageVersionTo,
      updated_at: new Date().toISOString()
    });
  }

  return {
    status: "ran",
    packageVersionFrom: options.packageVersionFrom,
    packageVersionTo,
    statePath,
    auditPath,
    results
  };
}

export async function runFirstRunMcpMigration(options: {
  packageVersion?: string;
  dataDir?: string;
  audit?: AuditLog;
  installOptions?: InstallOptions;
} = {}): Promise<FirstRunMcpMigrationRun> {
  const packageVersion = options.packageVersion ?? readPackageVersion();
  const dataDir = options.dataDir ?? resolveMigrationDataDir(options.installOptions);
  const statePath = resolveUpdateMigrationStatePath(dataDir);
  const auditPath = defaultAuditLogPath(dataDir);
  const state = readUpdateMigrationState(statePath);

  if (state.mcp_cleanup_version === packageVersion) {
    return {
      status: "current",
      packageVersion,
      statePath,
      auditPath,
      results: []
    };
  }

  return runStaleMcpCleanup({
    harnesses: "all",
    reason: "first-run",
    packageVersionFrom: state.mcp_cleanup_version,
    packageVersionTo: packageVersion,
    dataDir,
    audit: options.audit,
    installOptions: options.installOptions
  });
}

export function resolveUpdateMigrationStatePath(dataDir: string): string {
  return path.join(dataDir, UPDATE_MIGRATION_STATE_FILE);
}

export function readUpdateMigrationState(statePath: string): UpdateMigrationState {
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) return {};
    return {
      mcp_cleanup_version:
        typeof parsed.mcp_cleanup_version === "string"
          ? parsed.mcp_cleanup_version
          : undefined,
      updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : undefined
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return {};
  }
}

export function writeUpdateMigrationState(
  statePath: string,
  state: UpdateMigrationState
): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, statePath);
}

export function readPackageVersion(startUrl: string = import.meta.url): string {
  const root = findPackageRoot(fileURLToPath(startUrl));
  if (!root) return "unknown";

  try {
    const raw = fs.readFileSync(path.join(root, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version
      : "unknown";
  } catch {
    return "unknown";
  }
}

function resolveMigrationDataDir(
  installOptions: InstallOptions | undefined
): string {
  const options: ResolveDataDirOptions = {
    env: installOptions?.env,
    platform: installOptions?.platform,
    homeDir: installOptions?.homeDir
  };
  return resolveDataDir(options);
}

function findPackageRoot(startPath: string): string | null {
  let current: string;
  try {
    current = fs.statSync(startPath).isDirectory()
      ? startPath
      : path.dirname(startPath);
  } catch {
    current = path.dirname(startPath);
  }

  while (true) {
    const candidate = path.join(current, "package.json");
    if (fs.existsSync(candidate)) return current;

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
