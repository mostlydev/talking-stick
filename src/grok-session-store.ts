import fs from "node:fs";
import path from "node:path";
import { resolveDataDir, type ResolveDataDirOptions } from "./config.js";

export const DEFAULT_GROK_SESSION_RECORD_MAX_AGE_MS = 4 * 60 * 60 * 1000;
const GROK_IDENTITY_LIFECYCLE_EVENTS = new Set([
  "sessionstart",
  "userpromptsubmit",
  "sessionend"
]);

export interface GrokSessionRecord {
  source: "grok_hook";
  grok_session_id: string;
  workspace_root: string;
  cwd: string | null;
  event: string;
  observed_at: string;
  grok_pid: number | null;
  grok_process_started_at: string | null;
}

export interface AppendGrokSessionRecordOptions {
  logPath?: string;
  dataDirOptions?: ResolveDataDirOptions;
}

export interface FindGrokSessionRecordInput {
  logPath?: string;
  workspaceRoot: string | null | undefined;
  grokPid: number | null | undefined;
  grokProcessStartedAt: string | null | undefined;
  now?: Date;
  maxAgeMs?: number;
}

export function resolveGrokSessionLogPath(
  options: ResolveDataDirOptions = {}
): string {
  return path.join(resolveDataDir(options), "grok-sessions.jsonl");
}

export function appendGrokSessionRecord(
  record: GrokSessionRecord,
  options: AppendGrokSessionRecordOptions = {}
): boolean {
  const logPath =
    options.logPath ?? resolveGrokSessionLogPath(options.dataDirOptions ?? {});
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  if (!shouldAppendGrokSessionRecord(record, readGrokSessionRecords(logPath))) {
    return false;
  }
  fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf8");
  return true;
}

export function readGrokSessionRecords(logPath: string): GrokSessionRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(logPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const records: GrokSessionRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      const record = parseGrokSessionRecord(parsed);
      if (record) records.push(record);
    } catch {
      // Hook logs are append-only and best-effort; one bad line should not
      // break identity resolution for the whole session.
    }
  }
  return records;
}

export function findGrokSessionRecord(
  input: FindGrokSessionRecordInput
): GrokSessionRecord | null {
  const workspaceRoot = normalizeWorkspaceRoot(input.workspaceRoot);
  if (!workspaceRoot) return null;

  const logPath = input.logPath ?? resolveGrokSessionLogPath();
  const nowMs = input.now?.getTime() ?? Date.now();
  const maxAgeMs =
    input.maxAgeMs ?? DEFAULT_GROK_SESSION_RECORD_MAX_AGE_MS;
  const records = readGrokSessionRecords(logPath);
  const endedSessionIds = new Set<string>();
  const workspaceCandidates: GrokSessionRecord[] = [];

  for (const record of records.slice().reverse()) {
    if (normalizeWorkspaceRoot(record.workspace_root) !== workspaceRoot) {
      continue;
    }

    if (isGrokSessionEndEvent(record.event)) {
      endedSessionIds.add(record.grok_session_id);
      continue;
    }

    if (endedSessionIds.has(record.grok_session_id)) {
      continue;
    }

    const exactProcessMatch =
      input.grokPid != null &&
      input.grokProcessStartedAt != null &&
      record.grok_pid === input.grokPid &&
      record.grok_process_started_at === input.grokProcessStartedAt;
    if (exactProcessMatch) {
      return record;
    }
    if (isStaleRecord(record, nowMs, maxAgeMs)) {
      continue;
    }
    workspaceCandidates.push(record);
  }

  if (input.grokPid != null && input.grokProcessStartedAt != null) {
    return null;
  }

  const uniqueSessionIds = new Set(
    workspaceCandidates.map((record) => record.grok_session_id)
  );
  if (uniqueSessionIds.size === 1) {
    return workspaceCandidates[0] ?? null;
  }

  return null;
}

export function isGrokSessionEndEvent(event: string): boolean {
  return normalizeEventName(event) === "sessionend";
}

export function isGrokIdentityLifecycleEvent(event: string): boolean {
  return GROK_IDENTITY_LIFECYCLE_EVENTS.has(normalizeEventName(event));
}

function shouldAppendGrokSessionRecord(
  incoming: GrokSessionRecord,
  existingRecords: GrokSessionRecord[]
): boolean {
  const workspaceRoot = normalizeWorkspaceRoot(incoming.workspace_root);
  const sessionRecords = existingRecords.filter(
    (record) =>
      record.grok_session_id === incoming.grok_session_id &&
      normalizeWorkspaceRoot(record.workspace_root) === workspaceRoot
  );
  const latest = sessionRecords.at(-1);
  if (isGrokSessionEndEvent(incoming.event)) {
    return !latest || !isGrokSessionEndEvent(latest.event);
  }
  if (latest && isGrokSessionEndEvent(latest.event)) {
    return false;
  }

  const active = sessionRecords
    .slice()
    .reverse()
    .find((record) => !isGrokSessionEndEvent(record.event));
  if (!active) {
    return true;
  }

  const incomingHasExactProcess = hasExactGrokProcess(incoming);
  if (sameGrokProcess(active, incoming)) {
    return false;
  }
  return incomingHasExactProcess;
}

function hasExactGrokProcess(record: GrokSessionRecord): boolean {
  return (
    record.grok_pid !== null &&
    record.grok_process_started_at !== null
  );
}

function sameGrokProcess(
  left: GrokSessionRecord,
  right: GrokSessionRecord
): boolean {
  return (
    left.grok_pid === right.grok_pid &&
    left.grok_process_started_at === right.grok_process_started_at
  );
}

function parseGrokSessionRecord(value: unknown): GrokSessionRecord | null {
  if (!isObjectRecord(value)) return null;
  if (value.source !== "grok_hook") return null;

  const grokSessionId = nonEmptyString(value.grok_session_id);
  const workspaceRoot = nonEmptyString(value.workspace_root);
  const event = nonEmptyString(value.event);
  const observedAt = nonEmptyString(value.observed_at);
  if (!grokSessionId || !workspaceRoot || !event || !observedAt) {
    return null;
  }

  return {
    source: "grok_hook",
    grok_session_id: grokSessionId,
    workspace_root: workspaceRoot,
    cwd: nullableString(value.cwd),
    event,
    observed_at: observedAt,
    grok_pid: nullableInteger(value.grok_pid),
    grok_process_started_at: nullableString(value.grok_process_started_at)
  };
}

function isStaleRecord(
  record: GrokSessionRecord,
  nowMs: number,
  maxAgeMs: number
): boolean {
  const observedAtMs = Date.parse(record.observed_at);
  if (Number.isNaN(observedAtMs)) return true;
  return nowMs - observedAtMs > maxAgeMs;
}

function normalizeWorkspaceRoot(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    return fs.realpathSync.native(trimmed);
  } catch {
    return path.resolve(trimmed);
  }
}

function normalizeEventName(event: string): string {
  return event.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : null;
}

function nullableInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
