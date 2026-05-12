import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const tempRoots: string[] = [];
const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "prepare-release.mjs"
);

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe("prepare-release script", () => {
  test("moves Unreleased entries into a versioned changelog section and release note", () => {
    const tempRoot = createTempRoot();
    fs.writeFileSync(
      path.join(tempRoot, "CHANGELOG.md"),
      `# Changelog

Intro text.

## Unreleased

### Added
- **Automatic release prep.** Moves entries during version bumps.

### Fixed
- **Idle cleanup.** Keeps active sessions intact.

## [0.4.3] — 2026-05-11

Full notes: [\`docs/releases/0.4.3.md\`](docs/releases/0.4.3.md).

### Added
- Previous release.

[0.4.3]: https://github.com/mostlydev/talking-stick/releases/tag/v0.4.3
`
    );

    const output = execFileSync(
      process.execPath,
      [scriptPath, "--version", "0.4.4", "--date", "2026-05-12"],
      { cwd: tempRoot, encoding: "utf8" }
    );

    expect(output).toContain("Prepared release notes for 0.4.4.");
    const changelog = fs.readFileSync(
      path.join(tempRoot, "CHANGELOG.md"),
      "utf8"
    );
    expect(changelog).toContain("## Unreleased\n\n## [0.4.4] — 2026-05-12");
    expect(changelog).toContain(
      "Full notes: [`docs/releases/0.4.4.md`](docs/releases/0.4.4.md)."
    );
    expect(changelog).toContain(
      "[0.4.4]: https://github.com/mostlydev/talking-stick/releases/tag/v0.4.4\n[0.4.3]:"
    );

    const releaseNotes = fs.readFileSync(
      path.join(tempRoot, "docs", "releases", "0.4.4.md"),
      "utf8"
    );
    expect(releaseNotes).toContain("# Talking Stick 0.4.4");
    expect(releaseNotes).toContain("Date: 2026-05-12");
    expect(releaseNotes).toContain("## Added");
    expect(releaseNotes).toContain("## Fixed");
    expect(releaseNotes).toContain("npm pack --dry-run");
  });

  test("fails instead of creating an empty release", () => {
    const tempRoot = createTempRoot();
    fs.writeFileSync(
      path.join(tempRoot, "CHANGELOG.md"),
      `# Changelog

## Unreleased

## [0.4.3] — 2026-05-11

Existing release.
`
    );

    expect(() =>
      execFileSync(
        process.execPath,
        [scriptPath, "--version", "0.4.4", "--date", "2026-05-12"],
        { cwd: tempRoot, encoding: "utf8", stdio: "pipe" }
      )
    ).toThrow();
    expect(
      fs.existsSync(path.join(tempRoot, "docs", "releases", "0.4.4.md"))
    ).toBe(false);
  });

  test("stages generated files during npm version lifecycle", () => {
    const tempRoot = createTempRoot();
    fs.writeFileSync(
      path.join(tempRoot, "CHANGELOG.md"),
      `# Changelog

## Unreleased

### Added
- Staged release note.

## [0.4.3] — 2026-05-11

Existing release.
`
    );
    execFileSync("git", ["init"], { cwd: tempRoot });
    execFileSync("git", ["config", "user.email", "test@example.test"], {
      cwd: tempRoot
    });
    execFileSync("git", ["config", "user.name", "Test User"], {
      cwd: tempRoot
    });
    execFileSync("git", ["add", "CHANGELOG.md"], { cwd: tempRoot });
    execFileSync("git", ["commit", "-m", "Initial changelog"], {
      cwd: tempRoot
    });

    execFileSync(
      process.execPath,
      [scriptPath, "--version", "0.4.4", "--date", "2026-05-12"],
      {
        cwd: tempRoot,
        env: {
          ...process.env,
          npm_lifecycle_event: "version",
          npm_config_git_tag_version: "true"
        }
      }
    );

    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd: tempRoot,
      encoding: "utf8"
    });
    expect(staged.split("\n").filter(Boolean)).toEqual([
      "CHANGELOG.md",
      "docs/releases/0.4.4.md"
    ]);
  });
});

function createTempRoot(): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-release-"));
  tempRoots.push(tempRoot);
  return tempRoot;
}
