#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const CHANGELOG_PATH = "CHANGELOG.md";
const RELEASES_DIR = path.join("docs", "releases");
const PACKAGE_PATH = "package.json";
const RELEASE_URL_PREFIX =
  "https://github.com/mostlydev/talking-stick/releases/tag/v";

function main() {
  const options = parseArgs(process.argv.slice(2));
  const version = options.fromPackage
    ? readPackageVersion()
    : options.version;
  if (!version) {
    throw new Error("Usage: prepare-release --from-package | --version VERSION");
  }
  assertVersion(version);

  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const changelog = readText(CHANGELOG_PATH);
  const { nextChangelog, releaseBody } = prepareChangelog({
    changelog,
    version,
    date
  });

  const releasePath = path.join(RELEASES_DIR, `${version}.md`);
  if (fs.existsSync(releasePath)) {
    throw new Error(`${releasePath} already exists.`);
  }

  fs.mkdirSync(RELEASES_DIR, { recursive: true });
  writeText(CHANGELOG_PATH, nextChangelog);
  writeText(releasePath, renderReleaseNotes(version, date, releaseBody));

  console.log(`Prepared release notes for ${version}.`);
}

function parseArgs(args) {
  const options = {
    fromPackage: false,
    version: undefined,
    date: undefined
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--from-package") {
      options.fromPackage = true;
      continue;
    }
    if (arg === "--version") {
      options.version = requireValue(args, (index += 1), "--version");
      continue;
    }
    if (arg === "--date") {
      options.date = requireValue(args, (index += 1), "--date");
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (options.fromPackage && options.version) {
    throw new Error("Use either --from-package or --version, not both.");
  }

  return options;
}

function requireValue(args, index, name) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function readPackageVersion() {
  const parsed = JSON.parse(readText(PACKAGE_PATH));
  if (typeof parsed.version !== "string") {
    throw new Error("package.json does not contain a string version.");
  }
  return parsed.version;
}

function assertVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }
}

export function prepareChangelog({ changelog, version, date }) {
  const lines = changelog.replace(/\r\n/g, "\n").split("\n");
  const unreleasedIndex = lines.findIndex((line) => line === "## Unreleased");
  if (unreleasedIndex === -1) {
    throw new Error("CHANGELOG.md must contain a '## Unreleased' section.");
  }

  const duplicateIndex = lines.findIndex(
    (line) => line === `## [${version}] — ${date}` || line.startsWith(`## [${version}] `)
  );
  if (duplicateIndex !== -1) {
    throw new Error(`CHANGELOG.md already contains a ${version} section.`);
  }

  const nextSectionIndex = findNextVersionHeading(lines, unreleasedIndex + 1);
  const unreleasedBody = trimBlankLines(
    lines.slice(unreleasedIndex + 1, nextSectionIndex)
  );

  if (unreleasedBody.length === 0) {
    throw new Error("CHANGELOG.md Unreleased section is empty.");
  }

  const releaseSection = [
    "## Unreleased",
    "",
    `## [${version}] — ${date}`,
    "",
    `Full notes: [\`docs/releases/${version}.md\`](docs/releases/${version}.md).`,
    "",
    ...unreleasedBody,
    ""
  ];

  const nextLines = [
    ...lines.slice(0, unreleasedIndex),
    ...releaseSection,
    ...lines.slice(nextSectionIndex)
  ];

  const nextChangelog = ensureReleaseLink(
    `${nextLines.join("\n").replace(/\n*$/, "")}\n`,
    version
  );

  return {
    nextChangelog,
    releaseBody: unreleasedBody.join("\n")
  };
}

function findNextVersionHeading(lines, startIndex) {
  const nextIndex = lines.findIndex(
    (line, index) => index >= startIndex && /^##\s+/.test(line)
  );
  return nextIndex === -1 ? lines.length : nextIndex;
}

function trimBlankLines(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") {
    start += 1;
  }
  while (end > start && lines[end - 1].trim() === "") {
    end -= 1;
  }
  return lines.slice(start, end);
}

function ensureReleaseLink(changelog, version) {
  const reference = `[${version}]: ${RELEASE_URL_PREFIX}${version}`;
  const lines = changelog.replace(/\r\n/g, "\n").split("\n");

  if (lines.some((line) => line.startsWith(`[${version}]:`))) {
    return changelog;
  }

  const firstReferenceIndex = lines.findIndex((line) =>
    /^\[[^\]]+\]:\s+/.test(line)
  );
  if (firstReferenceIndex === -1) {
    return `${changelog.replace(/\n*$/, "")}\n\n${reference}\n`;
  }

  lines.splice(firstReferenceIndex, 0, reference);
  return `${lines.join("\n").replace(/\n*$/, "")}\n`;
}

function renderReleaseNotes(version, date, changelogBody) {
  return `# Talking Stick ${version}

Date: ${date}

${renderReleaseBody(changelogBody)}

## Verification

\`\`\`bash
npm run typecheck
npm test
npm run build
node dist/cli.js --help
git diff --check
npm pack --dry-run
\`\`\`
`;
}

function renderReleaseBody(changelogBody) {
  return changelogBody
    .split("\n")
    .map((line) => {
      const heading = /^(#{3,})\s+(.+)$/.exec(line);
      if (!heading) {
        return line;
      }
      return `${heading[1].slice(1)} ${heading[2]}`;
    })
    .join("\n");
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function writeText(filePath, content) {
  fs.writeFileSync(filePath, content, "utf8");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
