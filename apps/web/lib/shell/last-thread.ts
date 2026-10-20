/**
 * The way back from full-page routes (CE4, KOBE-197): the consoles and the agent and skill builders
 * leave the chat, and their "Kobe" link returns to the thread that was open. Kept per tab
 * (sessionStorage), like the chat's resume points, with the team it belongs to: a thread of another
 * team than the active one is never offered. Storage may be blocked, then the link goes to "/".
 */
const KEY = "kobe.lastThread";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Records the thread on screen in `teamId`; `undefined` (a new conversation) forgets it. */
export function rememberLastThread(teamId: string, threadId: string | undefined): void {
  try {
    if (threadId === undefined) sessionStorage.removeItem(KEY);
    else sessionStorage.setItem(KEY, JSON.stringify({ teamId, threadId }));
  } catch {
    // Storage blocked: the way back opens a new conversation instead.
  }
}

/** Switching teams or signing out: the remembered thread is no longer the way back. */
export function forgetLastThread(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Storage blocked: nothing was remembered.
  }
}

function stored(): { readonly teamId: string; readonly threadId: string } | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { teamId, threadId } = value as Record<string, unknown>;
    return typeof teamId === "string" && typeof threadId === "string" && UUID.test(threadId)
      ? { teamId, threadId }
      : null;
  } catch {
    return null;
  }
}

/**
 * The chat's address for the remembered thread, or "/" when there is none, it isn't an id, or it
 * belongs to another team than `activeTeamId` (the session's, which another tab may have switched).
 */
export function lastThreadHref(activeTeamId: string | null): string {
  const last = stored();
  if (last === null || last.teamId !== activeTeamId) return "/";
  return `/?thread=${last.threadId.toLowerCase()}`;
}

/**
 * The remembered thread of `teamId`, if any: the workspace under a panel opened by a link or a
 * reload (KOBE-452) shows it, as Close then returns to it.
 */
export function lastThreadId(teamId: string): string | undefined {
  const last = stored();
  return last !== null && last.teamId === teamId ? last.threadId.toLowerCase() : undefined;
}
