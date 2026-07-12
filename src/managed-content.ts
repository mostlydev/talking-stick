import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { resolveDataDir, type ResolveDataDirOptions } from "./config.js";

const STATE_FILE = "managed-content.json";

export type ManagedContentKind = "editable-instructions" | "skill-copy";

interface ManagedContentEntry {
  kind: ManagedContentKind;
  digest: string;
  offered_digest?: string;
  updated_at: string;
}

interface ManagedContentState {
  version: 1;
  entries: Record<string, ManagedContentEntry>;
}

export interface ManagedContentOptions extends ResolveDataDirOptions {
  dataDir?: string;
}

export function digestText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function digestDirectory(dirPath: string): string {
  const hash = crypto.createHash("sha256");
  for (const filePath of listFiles(dirPath)) {
    const relativePath = path.relative(dirPath, filePath).split(path.sep).join("/");
    hash.update(relativePath);
    hash.update("\0");
    hash.update(fs.readFileSync(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function getManagedContent(
  targetPath: string,
  options: ManagedContentOptions = {}
): ManagedContentEntry | null {
  return readState(options).entries[path.resolve(targetPath)] ?? null;
}

export function recordManagedContent(
  targetPath: string,
  kind: ManagedContentKind,
  digest: string,
  options: ManagedContentOptions = {}
): void {
  const state = readState(options);
  const key = path.resolve(targetPath);
  const existing = state.entries[key];
  if (
    existing?.kind === kind &&
    existing.digest === digest &&
    existing.offered_digest === undefined
  ) {
    return;
  }
  state.entries[key] = {
    kind,
    digest,
    updated_at: new Date().toISOString()
  };
  writeState(state, options);
}

export function recordManagedContentOffer(
  targetPath: string,
  offeredDigest: string,
  kind: ManagedContentKind,
  options: ManagedContentOptions = {}
): boolean {
  const state = readState(options);
  const key = path.resolve(targetPath);
  const existing = state.entries[key];
  if (existing?.offered_digest === offeredDigest) {
    return false;
  }
  state.entries[key] = {
    kind: existing?.kind ?? kind,
    digest: existing?.digest ?? "custom",
    offered_digest: offeredDigest,
    updated_at: new Date().toISOString()
  };
  writeState(state, options);
  return true;
}

function resolveStatePath(options: ManagedContentOptions): string {
  return path.join(options.dataDir ?? resolveDataDir(options), STATE_FILE);
}

function readState(options: ManagedContentOptions): ManagedContentState {
  try {
    const parsed = JSON.parse(fs.readFileSync(resolveStatePath(options), "utf8")) as {
      version?: unknown;
      entries?: unknown;
    };
    if (parsed.version === 1 && isPlainObject(parsed.entries)) {
      return { version: 1, entries: parsed.entries as Record<string, ManagedContentEntry> };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // Corrupt provenance must never block the CLI; rebuild it lazily.
    }
  }
  return { version: 1, entries: {} };
}

function writeState(
  state: ManagedContentState,
  options: ManagedContentOptions
): void {
  const statePath = resolveStatePath(options);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function listFiles(dirPath: string): string[] {
  const entries = fs
    .readdirSync(dirPath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
