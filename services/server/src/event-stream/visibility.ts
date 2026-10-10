/**
 * Who may watch a run's events: the people who may read its thread. That is the thread's owner
 * and, while it is shared (not in Trash), the members of its project (D23, read-only). Team admins
 * cannot read members' threads (D18) and install admins reach team content only through
 * break-glass (D10).
 */
export interface ThreadVisibility {
  readonly ownerUserId: string;
  /** The thread's project, null for a thread outside any project. */
  readonly projectId?: string | null;
  /** Shared to its project and not in Trash. */
  readonly sharedToProject?: boolean;
}

/** `projectIds`: the projects the viewer is a member of (`viewerProjectIds`). */
export function canWatchThread(
  thread: ThreadVisibility,
  userId: string,
  projectIds: readonly string[] = [],
): boolean {
  if (thread.ownerUserId === userId) return true;
  return (
    thread.sharedToProject === true &&
    thread.projectId != null &&
    projectIds.includes(thread.projectId)
  );
}
