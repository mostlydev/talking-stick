#!/usr/bin/env node
// Portable `chmod +x dist/cli.js`: Windows shells have no chmod, and the mode
// bit is meaningless there, so the build stays runnable on every platform.
const fs = require("node:fs");
const path = require("node:path");

fs.chmodSync(path.resolve(__dirname, "..", "dist", "cli.js"), 0o755);
