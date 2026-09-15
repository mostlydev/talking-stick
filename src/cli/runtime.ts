import {
  TalkingStickCommands,
  TalkingStickService
} from "../index.js";
import { createSystemNativeWakeTransport } from "../native-wake.js";
import { createSystemWakeTransport } from "../wake.js";

import type { DerivedIdentity } from "../identity.js";

export interface Runtime {
  commands: TalkingStickCommands;
  close: () => void;
}

export function createRuntime(): Runtime {
  const service = new TalkingStickService({
    wakeTransport: createSystemWakeTransport(),
    nativeWakeTransport: createSystemNativeWakeTransport()
  });
  return {
    commands: new TalkingStickCommands(service),
    close: () => service.close()
  };
}

// Records this harness session's native wake endpoints (Claude inbox socket,
// Codex thread). Absence or failure is a valid state: cmux and live receivers
// still work.
export function registerNativeWake(
  runtime: Runtime,
  identity: DerivedIdentity,
  roomId: string
): void {
  try {
    runtime.commands.registerNativeWakeEndpoints(identity, { room_id: roomId });
  } catch {
    // Wake registration never blocks coordination.
  }
}
