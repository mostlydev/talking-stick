#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const cliPath = path.resolve(__dirname, "..", "dist", "cli.js");
const packageRoot = path.resolve(__dirname, "..").replace(/\\/g, "/");

if (
  process.env.TALKING_STICK_DISABLE_MCP_MIGRATION ||
  !packageRoot.includes("/node_modules/talking-stick") ||
  !fs.existsSync(cliPath)
) {
  process.exit(0);
}

spawnSync(process.execPath, [cliPath, "migrate-mcp", "--reason", "update", "--quiet"], {
  stdio: "ignore",
  env: {
    ...process.env,
    TALKING_STICK_SKIP_STARTUP_MAINTENANCE: "1"
  }
});

process.exit(0);
