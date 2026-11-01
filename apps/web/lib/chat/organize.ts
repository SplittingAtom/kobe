/**
 * The owner's organization of a thread from the rail (CE19, KOBE-220): pin, archive, move to
 * project. The server rules each change (owner only, not in Trash; a move only where the member
 * may start a thread, never while a run is queued or running); the rail then reads its list again.
 */
import type { ApiResult } from "../api/client";
import type { ChatApi } from "./api";
import type { ThreadSummary } from "./types";

export type OrganizeAction = "pin" | "unpin" | "archive" | "unarchive";

export type OrganizeChange =
  | { readonly action: OrganizeAction }
  | { readonly action: "move"; readonly projectId: string | null };

export function organizeRequest(
  api: ChatApi,
  threadId: string,
  change: OrganizeChange,
): Promise<ApiResult<ThreadSummary>> {
  return change.action === "move"
    ? api.moveThread(threadId, change.projectId)
    : api.organizeThread(threadId, change.action);
}

/** What the row says for screen readers once the change is saved. */
export function organizedMessage(
  change: OrganizeChange,
  title: string,
  projectName?: string,
): string {
  switch (change.action) {
    case "pin":
      return `Pinned “${title}”.`;
    case "unpin":
      return `Unpinned “${title}”.`;
    case "archive":
      return `Archived “${title}”. It is in the Archived group and still found by search.`;
    case "unarchive":
      return `“${title}” is back in your threads.`;
    case "move":
      return change.projectId === null
        ? `Moved “${title}” out of its project.`
        : `Moved “${title}” to ${projectName ?? "the project"}. Its instructions apply from the next message.`;
  }
}

/** The row's short notice for a refusal. */
export const NOT_ORGANIZED: Readonly<Record<OrganizeChange["action"], string>> = {
  pin: "Not pinned",
  unpin: "Not unpinned",
  archive: "Not archived",
  unarchive: "Not unarchived",
  move: "Not moved",
};

/** A thread row being dragged onto a project header (CE19): carries the thread id only. */
export const THREAD_DRAG_TYPE = "application/x-kobe-thread";

/** Whether a drag carries a thread row (types are readable during dragover; data only on drop). */
export function carriesThread(data: DataTransfer | null): boolean {
  return data !== null && Array.from(data.types).includes(THREAD_DRAG_TYPE);
}

/**
 * Also set on a dragged row shared with the member (KOBE-536, TF8): it may be dropped on a folder
 * in the Threads panel's tree, never on a project header (only the owner moves it).
 */
export const SHARED_THREAD_DRAG_TYPE = "application/x-kobe-shared-thread";

export function carriesSharedThread(data: DataTransfer | null): boolean {
  return data !== null && Array.from(data.types).includes(SHARED_THREAD_DRAG_TYPE);
}
