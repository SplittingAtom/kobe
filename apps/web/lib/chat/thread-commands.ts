/**
 * Bindings of the open thread's own controls (KOBE-224) that both their button and the command
 * listings (`/` menu, palette) run, so the two can never differ.
 */
import type { MenuBinding } from "../shell/menu";
import type { ThreadController } from "./thread-controller";
import { placementOf } from "./thread-groups";
import { currentRunId, isBusy, isStopping, type ThreadState } from "./thread-state";

export const NOTHING_RUNNING = "Nothing is running.";
export const STOPPING = "Stopping…";
export const READ_ONLY = "This conversation is shared with you read-only.";
export const IN_TRASH = "Restore the conversation first.";
/** A draft (no thread yet): its actions wait for the first message. */
export const NO_THREAD = "Send a first message to start the conversation.";

/** Why Rename can't run (the header's pencil is hidden then), or null. */
export function renameBlocker(state: ThreadState): string | null {
  if (state.threadId === null) return NO_THREAD;
  if (state.summary === undefined) return "Opening the conversation…";
  if (state.summary.readOnly === true) return READ_ONLY;
  if (state.summary.deletedAt != null) return IN_TRASH;
  return null;
}

/**
 * Whether the viewer only reads this thread (KOBE-221): listed as shared with them, or so its
 * summary says once read. The rail row's menu and the open thread's bindings both ask this.
 */
export function threadReadOnly(custom: unknown, state: ThreadState | undefined): boolean {
  return placementOf(custom).shared || state?.summary?.readOnly === true;
}

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
