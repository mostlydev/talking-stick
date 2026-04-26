import {
  TalkingStickCommands,
  TalkingStickService
} from "../index.js";

export interface Runtime {
  commands: TalkingStickCommands;
  close: () => void;
}

export function createRuntime(): Runtime {
  const service = new TalkingStickService();
  return {
    commands: new TalkingStickCommands(service),
    close: () => service.close()
  };
}
