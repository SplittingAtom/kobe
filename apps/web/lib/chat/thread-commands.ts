/**
 * Bindings of the open thread's own controls (KOBE-224) that both their button and the command
 * listings (`/` menu, palette) run, so the two can never differ.
 */
import type { MenuBinding } from "../shell/menu";
import type { ThreadController } from "./thread-controller";
import { currentRunId, isBusy, isStopping, type ThreadState } from "./thread-state";

export const NOTHING_RUNNING = "Nothing is running.";
export const STOPPING = "Stopping…";
export const READ_ONLY = "This conversation is shared with you read-only.";

/** Stop (D17): the steering panel's button and `/stop`. */
export function stopBinding(
  controller: Pick<ThreadController, "stop">,
  state: ThreadState,
): MenuBinding {
  const blocker =
    state.summary?.readOnly === true
      ? READ_ONLY
      : currentRunId(state) === undefined
        ? NOTHING_RUNNING
        : isBusy(state, "stop") || isStopping(state)
          ? STOPPING
          : null;
  return { onSelect: () => void controller.stop(), blocker };
}
