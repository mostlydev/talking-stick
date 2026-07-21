import {
  TalkingStickCommands,
  TalkingStickService
} from "../index.js";
import { createSystemWakeTransport } from "../wake.js";

export interface Runtime {
  commands: TalkingStickCommands;
  close: () => void;
}

export function createRuntime(): Runtime {
  const service = new TalkingStickService({
    wakeTransport: createSystemWakeTransport()
  });
  return {
    commands: new TalkingStickCommands(service),
    close: () => service.close()
  };
}
