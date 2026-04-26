import os from "node:os";
import path from "node:path";
import type { Policy } from "./types.js";

export const defaultPolicy: Policy = {
  ownerLeaseTtlMs: 45 * 60 * 1000,
  heartbeatIntervalMs: 5 * 60 * 1000,
  claimTtlMs: 20 * 60 * 1000,
  waitForTurnMaxWaitMs: 30 * 1000,
  waitForTurnPollMs: 250,
  presenceTtlMs: 4 * 60 * 60 * 1000,
  waiterGraceMs: 10 * 1000
};

export interface ResolveDataDirOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
}

export function resolveDataDir(options: ResolveDataDirOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const pathModule = platform === "win32" ? path.win32 : path.posix;

  if (env.TALKING_STICK_DATA_DIR && env.TALKING_STICK_DATA_DIR.trim()) {
    return path.resolve(env.TALKING_STICK_DATA_DIR);
  }

  if (platform === "win32") {
    const appData = env.APPDATA;
    if (!appData) {
      return pathModule.join(homeDir, "AppData", "Roaming", "talking-stick");
    }
    return pathModule.join(appData, "talking-stick");
  }

  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  if (xdgDataHome) {
    return pathModule.join(xdgDataHome, "talking-stick");
  }

  return pathModule.join(homeDir, ".local", "share", "talking-stick");
}
