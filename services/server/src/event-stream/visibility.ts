/**
 * Who may watch a run's events: the people who may read its thread. In v1 that is the thread's
 * owner only. Threads are private to their author (D23); team admins cannot read members' threads
 * (D18) and install admins reach team content only through break-glass (D10, later). Read-only
 * access to threads shared to a project arrives with projects (KOBE-57) and is added here.
 */
export interface ThreadVisibility {
  readonly ownerUserId: string;
}

export function canWatchThread(thread: ThreadVisibility, userId: string): boolean {
  return thread.ownerUserId === userId;
}
