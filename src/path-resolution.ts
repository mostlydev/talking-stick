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

export interface ResolvedContextPath {
  requested_path: string;
  canonical_context_path: string;
  workspace_root: string;
}

export function resolveContextPath(contextPath: string): ResolvedContextPath {
  const requestedPath = path.resolve(contextPath);
  const canonicalContextPath = canonicalizeContextPath(requestedPath);
  const workspaceRoot = resolveWorkspaceRoot(canonicalContextPath);

  return {
    requested_path: requestedPath,
    canonical_context_path: canonicalContextPath,
    workspace_root: workspaceRoot
  };
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
  const gitRoot = resolveGitRoot(canonicalContextPath);
  if (gitRoot) {
    return gitRoot;
  }

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
  _workspaceRoot: string
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

  return ancestors;
}

function resolveGitRoot(canonicalContextPath: string): string | null {
  try {
    const output = execFileSync(
      "git",
      ["-C", canonicalContextPath, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();

    if (!output) {
      return null;
    }

    return fs.realpathSync.native(output);
  } catch {
    return null;
  }
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
