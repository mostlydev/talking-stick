import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function writeFileAtomic(filePath: string, data: string): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });

  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`
  );

  try {
    fs.writeFileSync(tempPath, data);
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Best effort cleanup for failed writes.
    }
    throw error;
  }
}
