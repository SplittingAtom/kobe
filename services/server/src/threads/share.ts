import type { ThreadVisibility } from "@kobe/protocol";

/**
 * Share scope of a thread (D23, CE20). Stored as `threads.shared_to_project` for now; this is the
 * one place that maps between the column and the wire `visibility`, so the later `team` scope
 * (KOBE-221, needs a column) changes here and in the readers' predicate only.
 */
export function visibilityOf(row: { readonly sharedToProject: boolean }): ThreadVisibility {
  return row.sharedToProject ? "project" : "private";
}

export function sharedToProjectFor(visibility: ThreadVisibility): boolean {
  return visibility === "project";
}
