/**
 * Share scopes in the chat (D23, CE20, KOBE-221): who reads a thread, as the menus and notices say
 * it. The server decides every change (owner only; the project scope needs a project).
 */
import type { ThreadSummary, ThreadVisibility } from "./types";

/** The Share submenu's choices, in order. */
export const SHARE_LABELS: Readonly<Record<ThreadVisibility, string>> = {
  private: "Only you",
  project: "Project members",
  team: "Everyone in the team",
};

/** The conversation's own announcement once its scope changed. */
export const SHARED_ANNOUNCEMENT: Readonly<Record<ThreadVisibility, string>> = {
  private: "Private again. Only you can see this conversation.",
  project: "Shared with the project. Its members can read and fork this conversation.",
  team: "Shared with the team. Everyone in it can read and fork this conversation.",
};

/** What the owner's sharing bar says under a shared thread. */
export const SHARED_HINT: Readonly<Record<Exclude<ThreadVisibility, "private">, string>> = {
  project: "Members of the project can read and fork this conversation.",
  team: "Everyone in the team can read and fork this conversation.",
};

/** The rail's announcement for a change made from a row's menu. */
export function sharedMessage(title: string, visibility: ThreadVisibility): string {
  switch (visibility) {
    case "private":
      return `“${title}” is private again: only you can see it.`;
    case "project":
      return `Shared “${title}” with the project's members: they can read and fork it.`;
    case "team":
      return `Shared “${title}” with everyone in the team: they can read and fork it.`;
  }
}

/** The thread's scope; older answers carry only `shared_to_project`. */
export function visibilityOf(summary: ThreadSummary): ThreadVisibility {
  return summary.visibility ?? (summary.sharedToProject ? "project" : "private");
}

/** The banner's first sentence for a reader. */
export function sharedBy(ownerName: string | null | undefined): string {
  return `Shared by ${ownerName ?? "a former member"}.`;
}
