import fs from "node:fs";
import path from "node:path";

import type { HarnessId } from "./install.js";

export type AuditAction = "removed" | "preserved" | "absent" | "skipped" | "failed";

export interface AuditEntry {
  ts: string;
  reason: AuditReason;
  package_version_from?: string;
  package_version_to?: string;
  harness: HarnessId;
  target_type: "skill";
  config_path?: string;
  action: AuditAction;
  target_name: string;
  detail?: string;
}

export interface CleanupResult {
  harness: HarnessId;
  action: AuditAction;
  message: string;
  target_type: "skill";
}

export type AuditReason = "update" | "first-run" | "uninstall" | "manual";

export interface AuditLog {
  append(entry: Omit<AuditEntry, "ts"> & { ts?: string }): void;
}

export class FileAuditLog implements AuditLog {
  constructor(private readonly filePath: string) {}

  append(entry: Omit<AuditEntry, "ts"> & { ts?: string }): void {
    const fullEntry: AuditEntry = { ts: entry.ts ?? new Date().toISOString(), ...entry };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, `${JSON.stringify(fullEntry)}\n`, "utf8");
  }
}

export class NoopAuditLog implements AuditLog {
  append(): void {
    // intentionally blank
  }
}

export function defaultAuditLogPath(dataDir: string): string {
  return path.join(dataDir, "update-migrations.log");
}
