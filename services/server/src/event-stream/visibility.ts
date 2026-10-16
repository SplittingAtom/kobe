/**
 * Who may watch a run's events: the people who may read its thread. That is the thread's owner
 * and, while it is shared (not in Trash), the members of its project (D23) or of the whole team
 * (CE20, KOBE-221), read-only. Team admins have no wider view (D18) and site admins reach team
 * content only through break-glass (D10). The team itself is RLS's and the reader's `team_id`.
 */
export interface ThreadVisibility {
  readonly ownerUserId: string;
  /** The thread's project, null for a thread outside any project. */
  readonly projectId?: string | null;
  /** Shared to its project and not in Trash. */
  readonly sharedToProject?: boolean;
  /** Shared with the team and not in Trash. */
  readonly sharedToTeam?: boolean;
}

/** `projectIds`: the projects the viewer is a member of (`viewerProjectIds`). */
export function canWatchThread(
  thread: ThreadVisibility,
  userId: string,
  projectIds: readonly string[] = [],
): boolean {
  if (thread.ownerUserId === userId) return true;
  if (thread.sharedToTeam === true) return true;
  return (
    thread.sharedToProject === true &&
    thread.projectId != null &&
    projectIds.includes(thread.projectId)
  );
}
