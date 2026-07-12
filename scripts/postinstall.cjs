#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const cliPath = path.resolve(__dirname, "..", "dist", "cli.js");
const packageRoot = path.resolve(__dirname, "..").replace(/\\/g, "/");
const skillerBootstrapPath = path.resolve(__dirname, "skiller-bootstrap.cjs");

if (!packageRoot.includes("/node_modules/talking-stick") || !fs.existsSync(cliPath)) {
  process.exit(0);
}

const skiller = spawnSync(process.execPath, [skillerBootstrapPath], {
  encoding: "utf8",
  stdio: ["ignore", "ignore", "pipe"],
  env: process.env
});
if (skiller.status !== 0 && process.env.TALKING_STICK_REQUIRE_SKILLER) {
  process.stderr.write(skiller.stderr || "skiller bootstrap failed\n");
  process.exit(skiller.status || 1);
}
if (skiller.status !== 0 && !process.env.TALKING_STICK_QUIET_POSTINSTALL) {
  process.stderr.write(
    `talking-stick: skiller bootstrap skipped/failed; TypeScript fallback remains available. ${skiller.stderr || ""}`.trim() + "\n"
  );
}

// Refresh recorded, unedited copies without overwriting custom content.
// Offers for customized files are shown on the next tt invocation.
spawnSync(process.execPath, [path.resolve(__dirname, "postinstall-sync.mjs")], {
  stdio: "ignore",
  env: process.env
});

process.exit(0);
