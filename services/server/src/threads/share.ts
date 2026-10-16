import type { ThreadVisibility } from "@kobe/protocol";

/**
 * Share scope of a thread (D23, CE20, KOBE-221): `private`, `project` (members of its project) or
 * `team` (every member of the team), read-only for everyone but the owner. Stored as two columns,
 * `threads.shared_to_project` and `threads.shared_to_team`, at most one of them true (CHECK
 * `threads_share_scope`); this is the one place that maps between them and the wire `visibility`.
 */
export interface ShareColumns {
  readonly sharedToProject: boolean;
  readonly sharedToTeam: boolean;
}

export function visibilityOf(row: {
  readonly sharedToProject: boolean;
  readonly sharedToTeam?: boolean;
}): ThreadVisibility {
  if (row.sharedToTeam === true) return "team";
  return row.sharedToProject ? "project" : "private";
}

export function shareColumnsFor(visibility: ThreadVisibility): ShareColumns {
  return { sharedToProject: visibility === "project", sharedToTeam: visibility === "team" };
}

/**
 * True when the change can take readers away: any revoke, and team to project (a project's members
 * are all in the team, so project to team only adds readers). Open reader streams are then told to
 * recheck at once (`notifyThreadAccess`), not at the next periodic revalidation.
 */
export function narrows(from: ThreadVisibility, to: ThreadVisibility): boolean {
  if (to === "private") return from !== "private";
  return from === "team" && to === "project";
}
