import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workspaceMarkers = [
  "CLAUDE.md",
  "AGENTS.md",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod"
];

// A directory holding this file is an explicit room boundary. It is plain
// content, so every checkout and worktree of a branch resolves the same way.
export const ROOM_DECLARATION_FILE = path.join(".talking-stick", "room.toml");

export interface RoomDeclaration {
  /** Directory that holds `.talking-stick/room.toml` in the caller's checkout. */
  directory: string;
  /** Path of that directory relative to the checkout root ("" for the root). */
  rel_path: string;
  name: string | null;
  /** Set when the file has content tt does not understand; it still declares the room. */
  problem: string | null;
}

export interface ResolvedContextPath {
  requested_path: string;
  canonical_context_path: string;
  /** Coordination root: the main checkout for Git worktrees. */
  workspace_root: string;
  /** Git checkout that contains the context path, when inside Git. */
  checkout_root: string | null;
  declaration: RoomDeclaration | null;
  /** Where this context's room lives when no nearer legacy room exists. */
  room_path: string;
}

export interface GitRoots { checkout_root: string; coordination_root: string }

export interface ResolveContextOptions {
  /**
   * How to find the Git roots. The default asks git; a shell prompt passes
   * resolveGitRootsFromFilesystem, which spawns nothing.
   */
  gitRoots?: (canonicalContextPath: string) => GitRoots | null;
}

export function resolveContextPath(contextPath: string, options: ResolveContextOptions = {}): ResolvedContextPath {
  const requestedPath = path.resolve(contextPath);
  const canonicalContextPath = canonicalizeContextPath(requestedPath);
  const git = (options.gitRoots ?? resolveGitRoots)(canonicalContextPath);
  const workspaceRoot = git?.coordination_root ?? resolveNonGitWorkspaceRoot(canonicalContextPath);
  const declaration = findRoomDeclaration(canonicalContextPath, git?.checkout_root ?? null);
  // A declared room is keyed by the coordination root plus its checkout-relative
  // path, so <worktree>/pkg and <main>/pkg name the same room.
  const roomPath = declaration
    ? git ? path.join(workspaceRoot, declaration.rel_path) : declaration.directory
    : workspaceRoot;

  return {
    requested_path: requestedPath,
    canonical_context_path: canonicalContextPath,
    workspace_root: workspaceRoot,
    checkout_root: git?.checkout_root ?? null,
    declaration,
    room_path: roomPath
  };
}

// Existing rooms that may serve this context, most specific first. Inside Git
// the search never leaves the checkout: a repository is its own root, so an
// older room above it no longer absorbs it. Outside Git, folders still bubble
// up to the nearest existing room, bounded by $HOME.
export function roomCandidatePaths(resolved: ResolvedContextPath): string[] {
  const stop = resolved.declaration?.directory ?? resolved.checkout_root;
  if (!stop) {
    return ancestorPaths(resolved.canonical_context_path, resolved.workspace_root);
  }
  const candidates: string[] = [];
  let current = resolved.canonical_context_path;
  // Nearer legacy rooms (created with --force-new) keep winning, so live
  // members, leases, and cursors are never moved by an upgrade.
  while (isWithinOrSame(current, stop) && !samePath(current, stop)) {
    candidates.push(current);
    const parent = path.dirname(current);
    if (samePath(parent, current)) break;
    current = parent;
  }
  // In a linked worktree the declaration directory (or checkout root) is not
  // the keyed room path; a legacy room created exactly there still wins.
  if (!samePath(stop, resolved.room_path)) {
    candidates.push(stop);
  }
  candidates.push(resolved.room_path);
  return candidates;
}

export function canonicalizeContextPath(contextPath: string): string {
  const resolved = path.resolve(contextPath);

  let directoryPath = resolved;
  try {
    const stat = fs.statSync(resolved);
    if (stat.isFile()) {
      directoryPath = path.dirname(resolved);
    }
  } catch {
    directoryPath = resolved;
  }

  try {
    return fs.realpathSync.native(directoryPath);
  } catch {
    return path.normalize(directoryPath);
  }
}

export function resolveWorkspaceRoot(canonicalContextPath: string): string {
  return resolveGitRoots(canonicalContextPath)?.coordination_root ??
    resolveNonGitWorkspaceRoot(canonicalContextPath);
}

function resolveNonGitWorkspaceRoot(canonicalContextPath: string): string {
  const markerRoot = findNearestWorkspaceMarker(canonicalContextPath);
  if (markerRoot) {
    return markerRoot;
  }

  return canonicalContextPath;
}

// Existing rooms are an explicit coordination boundary, even across nested
// Git/project roots. Stop before HOME so an intentionally broad home room does
// not absorb unrelated descendant workspaces. The second argument remains for
// API compatibility; new-room creation still uses the resolved workspace root.
export function ancestorPaths(
  canonicalContextPath: string,
  workspaceRoot: string
): string[] {
  const ancestors: string[] = [];
  const homeBoundary = resolveHomeMarkerBoundary(canonicalContextPath);
  let current = canonicalContextPath;

  while (true) {
    if (homeBoundary && samePath(current, homeBoundary)) {
      break;
    }

    const parent = path.dirname(current);
    if (samePath(parent, current)) {
      break;
    }

    ancestors.push(current);
    current = parent;
  }

  // A linked Git worktree's coordination root is the main repository root,
  // which is a sibling rather than a filesystem ancestor. Keep real ancestors
  // first so an explicitly forced per-worktree room still wins, then add the
  // shared repository root and its ancestors as the default fallback.
  if (
    !ancestors.some((candidate) => samePath(candidate, workspaceRoot)) &&
    (!homeBoundary || !samePath(workspaceRoot, homeBoundary))
  ) {
    const sharedHomeBoundary = resolveHomeMarkerBoundary(workspaceRoot);
    let candidate = workspaceRoot;
    while ((!sharedHomeBoundary || !samePath(candidate, sharedHomeBoundary)) &&
      !samePath(path.dirname(candidate), candidate)) {
      if (!ancestors.some((existing) => samePath(existing, candidate))) {
        ancestors.push(candidate);
      }
      candidate = path.dirname(candidate);
    }
  }

  return ancestors;
}

function resolveGitRoots(canonicalContextPath: string): GitRoots | null {
  try {
    const checkoutRoot = execFileSync(
      "git",
      ["-C", canonicalContextPath, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();

    if (!checkoutRoot) {
      return null;
    }
    const realCheckoutRoot = fs.realpathSync.native(checkoutRoot);

    const commonDirectory = execFileSync(
      "git",
      [
        "-C",
        canonicalContextPath,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir"
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();

    // Ordinary repositories and their linked worktrees share <main>/.git.
    // More exotic layouts (notably submodules whose common dir lives under
    // .git/modules) retain their checkout root instead of guessing a wrong
    // working-tree path from an internal Git directory.
    const coordinationRoot =
      commonDirectory && path.basename(commonDirectory) === ".git"
        ? path.dirname(commonDirectory)
        : checkoutRoot;
    return { checkout_root: realCheckoutRoot, coordination_root: fs.realpathSync.native(coordinationRoot) };
  } catch {
    return null;
  }
}

/**
 * The same roots as resolveGitRoots, read from the filesystem: the nearest
 * `.git` directory is an ordinary checkout; a `.git` file points at a linked
 * worktree's or a submodule's git dir, whose `commondir` names the shared
 * repository. As there, only a common dir named `.git` moves the coordination
 * root; any other layout keeps the checkout root.
 */
export function resolveGitRootsFromFilesystem(canonicalContextPath: string): GitRoots | null {
  try {
    let current = canonicalContextPath;
    while (true) {
      const marker = path.join(current, ".git");
      let stat: fs.Stats | null = null;
      try { stat = fs.statSync(marker); } catch { stat = null; }
      if (stat?.isDirectory()) {
        const root = fs.realpathSync.native(current);
        return { checkout_root: root, coordination_root: root };
      }
      if (stat?.isFile()) {
        const checkoutRoot = fs.realpathSync.native(current);
        const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(marker, "utf8"));
        if (!pointer) return null;
        const gitDir = path.resolve(current, pointer[1]);
        let commonDir = gitDir;
        try {
          const common = fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
          if (common) commonDir = path.resolve(gitDir, common);
        } catch { /* A submodule's git dir has no commondir: it is its own. */ }
        const coordinationRoot = path.basename(commonDir) === ".git" ? path.dirname(commonDir) : checkoutRoot;
        return { checkout_root: checkoutRoot, coordination_root: fs.realpathSync.native(coordinationRoot) };
      }
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  } catch {
    return null;
  }
}

// Walk up to the checkout root inside Git, or to the $HOME boundary outside it.
function findRoomDeclaration(startPath: string, checkoutRoot: string | null): RoomDeclaration | null {
  const homeBoundary = checkoutRoot ? null : resolveHomeMarkerBoundary(startPath);
  let current = startPath;
  while (true) {
    if (homeBoundary && samePath(current, homeBoundary)) return null;
    const file = path.join(current, ROOM_DECLARATION_FILE);
    if (fs.existsSync(file)) {
      const parsed = readDeclaration(file);
      return {
        directory: current,
        rel_path: checkoutRoot ? path.relative(checkoutRoot, current).split(path.sep).join("/") : "",
        name: parsed.name,
        problem: parsed.problem
      };
    }
    if (checkoutRoot && samePath(current, checkoutRoot)) return null;
    const parent = path.dirname(current);
    if (samePath(parent, current)) return null;
    current = parent;
  }
}

// The file's presence is the declaration. Known keys are read; anything else
// is reported so a typo is visible instead of silently ignored.
// Channels are reserved for a later release; accepting their keys silently
// would suggest they work.
const DECLARATION_KEYS = new Set(["name"]);
export function readDeclaration(file: string): { name: string | null; problem: string | null } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { name: null, problem: `${file} is unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  let name: string | null = null;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(line);
    if (!match || !DECLARATION_KEYS.has(match[1])) {
      return { name, problem: `${file}:${index + 1} is not understood: ${raw.trim()}` };
    }
    if (match[1] === "name") {
      const value = /^"([^"\n]*)"$/.exec(match[2]);
      if (!value) return { name, problem: `${file}:${index + 1}: name must be a quoted string` };
      name = value[1].trim() || null;
    }
  }
  return { name, problem: null };
}

function findNearestWorkspaceMarker(startPath: string): string | null {
  const homeMarkerBoundary = resolveHomeMarkerBoundary(startPath);
  let current = startPath;

  while (true) {
    if (homeMarkerBoundary && samePath(current, homeMarkerBoundary)) {
      return null;
    }

    for (const marker of workspaceMarkers) {
      if (fs.existsSync(path.join(current, marker))) {
        return current;
      }
    }

    const parent = path.dirname(current);
    if (samePath(parent, current)) {
      return null;
    }
    current = parent;
  }
}

function resolveHomeMarkerBoundary(startPath: string): string | null {
  const homeDir = os.homedir();
  if (!homeDir) {
    return null;
  }

  const resolvedHomeDir = path.resolve(homeDir);
  const candidateHomes = [
    canonicalizeDirectoryPath(resolvedHomeDir),
    path.normalize(resolvedHomeDir)
  ];

  for (const candidateHome of candidateHomes) {
    if (
      !samePath(startPath, candidateHome) &&
      isWithinOrSame(startPath, candidateHome)
    ) {
      return candidateHome;
    }
  }

  return null;
}

function canonicalizeDirectoryPath(directoryPath: string): string {
  try {
    return fs.realpathSync.native(directoryPath);
  } catch {
    return path.normalize(directoryPath);
  }
}

function samePath(left: string, right: string): boolean {
  return path.normalize(left) === path.normalize(right);
}

export function isWithinOrSame(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

// A nested Git repository below the anchor has its own rooms. Paths that do
// not exist here (keyed under the main checkout) are kept.
export function insideNestedRepository(roomPath: string, anchor: string): boolean {
  let current = roomPath;
  while (current !== anchor && isWithinOrSame(current, anchor)) {
    if (fs.existsSync(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}
