import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export default function setup() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-test-data-"));
  process.env.TALKING_STICK_DATA_DIR = tempDir;

  return () => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  };
}
