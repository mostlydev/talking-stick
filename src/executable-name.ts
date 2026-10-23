import path from "node:path";

export function executableName(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return path.win32.basename(value).replace(/\.(exe|com|cmd|bat)$/i, "").toLowerCase();
  }
  return path.posix.basename(value);
}

export function commandExecutable(command: string): string {
  // Windows quotes argv[0] when the install directory contains spaces.
  return command.trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/)?.slice(1).find(Boolean) ?? "";
}
