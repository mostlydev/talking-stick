import type { WaitForTurnResult } from "./types.js";

export interface SignalWaitOptions {
  is_try: boolean;
  explicit_timeout: boolean;
  on_internal_timeout?: (result: WaitForTurnResult) => void;
}

export async function waitForActionableSignal(
  waitOnce: () => Promise<WaitForTurnResult>,
  options: SignalWaitOptions
): Promise<WaitForTurnResult> {
  while (true) {
    const result = await waitOnce();
    if (
      options.is_try ||
      options.explicit_timeout ||
      result.wake_reason !== "timeout"
    ) {
      return result;
    }
    options.on_internal_timeout?.(result);
  }
}
