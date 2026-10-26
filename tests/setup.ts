import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export default function setup() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-test-data-"));
  process.env.TALKING_STICK_DATA_DIR = tempDir;
  // Supervisor state never lands in the real user state directory during
  // tests, and stays short enough for its UNIX socket paths.
  const stateDir = fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "tt-svs-"));
  process.env.TT_SUPERVISOR_STATE_DIR = stateDir;
  process.env.TT_NO_AUTO_UPDATE = "1";
  // Terminal-mode chat tests drive Node's readline directly, and readline
  // silently disables line editing under TERM=dumb (as in Grok tool shells).
  // Pin a capable terminal so those tests do not depend on the caller's TERM;
  // chatTerminalCapable covers the dumb-terminal product path explicitly.
  if (!process.env.TERM || process.env.TERM === "dumb") {
    process.env.TERM = "xterm-256color";
  }

  return () => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  };
}
