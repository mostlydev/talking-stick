import {
  type HarnessId,
  type InstallOptions,
  type InstallResult,
  type InstallTargetState,
  SUPPORTED_HARNESSES,
  planUninstall,
  runAction
} from "./install.js";
import { type AuditAction, type AuditLog, type AuditReason, NoopAuditLog } from "./install-audit.js";

export interface RemoveStaleMcpOptions {
  harnesses?: readonly HarnessId[] | "all";
  reason: AuditReason;
  packageVersionFrom?: string;
  packageVersionTo?: string;
  audit?: AuditLog;
  /**
   * When true (default), opencode entries are only removed if their value matches
   * the canonical Talking Stick install shape. Hand-edited entries are preserved.
   * Exec harnesses (claude-code, codex, gemini) currently fall back to name-only
   * matching because their CLIs do not expose the registered command shape in a
   * stable parsable form; Grok has no MCP cleanup path and is skipped.
   */
  strict?: boolean;
  installOptions?: InstallOptions;
}

export interface RemoveStaleMcpResult {
  harness: HarnessId;
  action: AuditAction;
  message: string;
}

export async function removeStaleMcpRegistrations(
  options: RemoveStaleMcpOptions
): Promise<RemoveStaleMcpResult[]> {
  const audit = options.audit ?? new NoopAuditLog();
  const strict = options.strict ?? true;
  const harnesses =
    options.harnesses === undefined || options.harnesses === "all"
      ? [...SUPPORTED_HARNESSES]
      : options.harnesses;
  const installOptions: InstallOptions = {
    skipMissing: true,
    ...(options.installOptions ?? {})
  };

  const results: RemoveStaleMcpResult[] = [];
  for (const harness of harnesses) {
    const result = await removeOneHarness(harness, installOptions, strict);
    results.push(result);
    audit.append({
      reason: options.reason,
      package_version_from: options.packageVersionFrom,
      package_version_to: options.packageVersionTo,
      harness,
      config_path: result.configPath,
      action: result.action,
      server_name: result.serverName,
      detail: result.message
    });
  }
  return results.map(({ harness, action, message }) => ({ harness, action, message }));
}

interface InternalResult extends RemoveStaleMcpResult {
  configPath?: string;
  serverName: string;
}

async function removeOneHarness(
  harness: HarnessId,
  installOptions: InstallOptions,
  strict: boolean
): Promise<InternalResult> {
  const action = planUninstall(harness, installOptions);

  if (action.kind === "skip") {
    return {
      harness,
      action: "skipped",
      message: action.message,
      serverName: installOptions.serverName ?? "talking-stick"
    };
  }

  if (action.kind === "file-patch") {
    const state: InstallTargetState = action.inspect ? action.inspect() : "unknown";
    const serverName = action.serverName ?? "talking-stick";
    if (state === "absent") {
      return {
        harness,
        action: "absent",
        message: `${harness}: no Talking Stick MCP entry to remove`,
        configPath: action.filePath,
        serverName
      };
    }
    if (strict && state !== "present") {
      return {
        harness,
        action: "preserved",
        message: `${harness}: hand-edited entry left alone (state=${state})`,
        configPath: action.filePath,
        serverName
      };
    }
  }

  const installResult = await runAction(action, installOptions);
  return mapInstallResult(harness, action, installResult);
}

function mapInstallResult(
  harness: HarnessId,
  action: ReturnType<typeof planUninstall>,
  result: InstallResult
): InternalResult {
  let serverName = "talking-stick";
  if ("serverName" in action && typeof action.serverName === "string") {
    serverName = action.serverName;
  }
  const configPath = action.kind === "file-patch" ? action.filePath : undefined;

  if (!result.ok) {
    return { harness, action: "failed", message: result.message, configPath, serverName };
  }
  switch (result.status) {
    case "already_absent":
      return { harness, action: "absent", message: result.message, configPath, serverName };
    case "removed":
      return { harness, action: "removed", message: result.message, configPath, serverName };
    case "skipped":
      return { harness, action: "skipped", message: result.message, configPath, serverName };
    default:
      return { harness, action: "failed", message: result.message, configPath, serverName };
  }
}
