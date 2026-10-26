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

/** Writable roots conflict with a protected path when they hold it, replace a parent of it, or lie inside it. */
export function pathsConflict(writable: string, guarded: string): boolean {
  const a = canonicalPath(writable);
  const b = canonicalPath(guarded);
  return a === b || isInside(b, a) || isInside(a, b);
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
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

/** This supervisor's own program: the runtime it runs on and the package it was loaded from. */
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
    if (root) paths.push(root); else unresolved.push(`the package that holds ${moduleFile}`);
  }
  return { paths, unresolved };
}

/**
 * Why this live worker makes a gate ineligible; empty when it doesn't. Its
 * confinement comes from what the native process reported, never the spec.
 */
export function workerIneligibility(workerId: string, handle: WorkerHandle, guarded: ProtectedSet): string[] {
  const reasons: string[] = [];
  const confinement = handle.confinement?.() ?? { kind: "unconfined", reason: "its harness reports no write confinement" };
  if (confinement.kind === "unconfined") {
    reasons.push(`${workerId} is not write-confined: ${confinement.reason}.`);
    return reasons;
  }
  const closure = handle.executionClosure?.() ?? { paths: [], unresolved: ["its native executable"] };
  for (const missing of closure.unresolved) reasons.push(`${workerId}: ${missing} couldn't be resolved.`);
  if (confinement.kind === "read_only") return reasons;
  const all = [...guarded.paths, ...closure.paths];
  for (const writable of confinement.writable) {
    for (const guardedPath of all) {
      if (pathsConflict(writable, guardedPath)) reasons.push(`${workerId} can write ${writable}, which reaches ${guardedPath}.`);
    }
  }
  return reasons;
}
