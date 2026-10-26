import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerHandle } from "./adapter.js";
import { canonicalPath } from "./root.js";

// Whether a human gate may act at all (docs/supervisor.md, "Gate eligibility").
// A confirmation means nothing if a worker can rewrite the supervisor's state,
// its program, or what runs at the next start. So every live worker's
// effective, native-reported write confinement must stay clear of all of them.

/** What the supervisor's own correctness rests on, canonical where it exists. */
export interface ProtectedSet {
  paths: string[];
  /** Anything that couldn't be resolved: then nothing is eligible. */
  unresolved: string[];
}

/**
 * Writable roots conflict with a protected path when they hold it, replace a
 * parent of it, or lie inside it. Both sides are compared as written and as
 * resolved, and the protected side also by every symlink its resolution passes
 * through, since whoever can replace a link changes what it names.
 */
export function pathsConflict(writable: string, guarded: string): boolean {
  const writableForms = [...new Set([path.resolve(writable), canonicalPath(writable)])];
  const guardedForms = resolutionEntries(guarded);
  return writableForms.some((a) => guardedForms.some((b) => a === b || isInside(b, a) || isInside(a, b)));
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  if (relative === "" || path.isAbsolute(relative)) return false;
  // A ".." segment leaves the parent; a child merely named "..something" does not.
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

/**
 * The path as written, each symlink met while resolving it (the entry that a
 * writer could replace), and where it finally resolves, even if that doesn't exist yet.
 */
export function resolutionEntries(target: string, depth = 0): string[] {
  if (depth > 40) throw new Error(`Too many symlinks resolving ${target}.`);
  const absolute = path.resolve(target);
  const entries = new Set<string>([absolute]);
  const { root } = path.parse(absolute);
  const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    const next = path.join(current, parts[index]);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(next); }
    catch { entries.add(path.join(next, ...parts.slice(index + 1))); return [...entries]; }
    if (stat.isSymbolicLink()) {
      entries.add(next);
      const resolved = path.resolve(path.dirname(next), fs.readlinkSync(next));
      for (const entry of resolutionEntries(path.join(resolved, ...parts.slice(index + 1)), depth + 1)) entries.add(entry);
      return [...entries];
    }
    current = next;
  }
  entries.add(current);
  return [...entries];
}

/** The nearest directory at or above a file that holds a package.json: what a script runtime loads from. */
export function packageRoot(file: string): string | null {
  let dir = path.dirname(canonicalPath(file));
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Directories a package-load walk may visit before giving up as unresolved. */
const LOAD_WALK_LIMIT = 200_000;

/**
 * Everything a package's code may load from outside it: every symlink under
 * its directory, followed to its target. A package root alone isn't proof of
 * what loads, since a linked dependency can live anywhere.
 */
export function packageLinkTargets(root: string): ProtectedSet {
  const paths: string[] = [];
  const pending = [root];
  let visited = 0;
  while (pending.length) {
    const dir = pending.pop()!;
    if (++visited > LOAD_WALK_LIMIT) return { paths, unresolved: [`the dependencies under ${root} (too many to walk)`] };
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return { paths, unresolved: [`the dependencies under ${dir}`] }; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        try { paths.push(full, canonicalPath(full)); }
        catch { return { paths, unresolved: [`the link ${full}`] }; }
      } else if (entry.isDirectory() && entry.name !== ".git") {
        pending.push(full);
      }
    }
  }
  return { paths, unresolved: [] };
}

/** This supervisor's own program: the runtime it runs on, the package it was loaded from, and what that links to. */
export function supervisorProgramPaths(options: { execPath?: string; moduleFile?: string; standaloneRoot?: string | null } = {}): ProtectedSet {
  const paths: string[] = [];
  const unresolved: string[] = [];
  const runtime = options.execPath ?? process.execPath;
  if (fs.existsSync(runtime)) paths.push(canonicalPath(runtime)); else unresolved.push(`the runtime ${runtime}`);
  if (options.standaloneRoot) {
    paths.push(canonicalPath(options.standaloneRoot));
  } else {
    const moduleFile = options.moduleFile ?? fileURLToPath(import.meta.url);
    const root = packageRoot(moduleFile);
    if (root) {
      paths.push(root);
      const links = packageLinkTargets(root);
      paths.push(...links.paths);
      unresolved.push(...links.unresolved);
    } else {
      unresolved.push(`the package that holds ${moduleFile}`);
    }
  }
  return { paths, unresolved };
}

/** A worker's own startup closure; a handle that can't say has an unresolved one. */
export function handleClosure(handle: WorkerHandle): { paths: string[]; unresolved: string[] } {
  return handle.executionClosure?.() ?? { paths: [], unresolved: ["its native executable"] };
}

/**
 * Why this live worker makes a gate ineligible; empty when it doesn't. Its
 * confinement comes from what the native process reported, never the spec.
 * `guarded` must hold every worker's startup closure, not only this one's:
 * one worker rewriting another's executable is as bad as rewriting its own.
 */
export function workerIneligibility(workerId: string, handle: WorkerHandle, guarded: ProtectedSet): string[] {
  const reasons: string[] = [];
  const confinement = handle.confinement?.() ?? { kind: "unconfined", reason: "its harness reports no write confinement" };
  if (confinement.kind === "unconfined") {
    reasons.push(`${workerId} is not write-confined: ${confinement.reason}.`);
    return reasons;
  }
  for (const missing of handleClosure(handle).unresolved) reasons.push(`${workerId}: ${missing} couldn't be resolved.`);
  if (confinement.kind === "read_only") return reasons;
  for (const writable of confinement.writable) {
    for (const guardedPath of guarded.paths) {
      if (pathsConflict(writable, guardedPath)) reasons.push(`${workerId} can write ${writable}, which reaches ${guardedPath}.`);
    }
  }
  return reasons;
}
