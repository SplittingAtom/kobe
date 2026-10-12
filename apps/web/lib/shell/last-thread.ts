/**
 * The way back from full-page routes (CE4, KOBE-197): the consoles and the agent and skill builders
 * leave the chat, and their "Kobe" link returns to the thread that was open. Kept per tab
 * (sessionStorage), like the chat's resume points; storage may be blocked, then the link goes to "/".
 */
const KEY = "kobe.lastThreadId";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Records the thread on screen; `undefined` (a new conversation) forgets it. */
export function rememberLastThread(threadId: string | undefined): void {
  try {
    if (threadId === undefined) sessionStorage.removeItem(KEY);
    else sessionStorage.setItem(KEY, threadId);
  } catch {
    // Storage blocked: the way back opens a new conversation instead.
  }
}

/** Switching teams: the remembered thread belongs to the old team. */
export function forgetLastThread(): void {
  rememberLastThread(undefined);
}

/** The chat's address for the remembered thread, or "/" when there is none (or it isn't an id). */
export function lastThreadHref(): string {
  let id: string | null;
  try {
    id = sessionStorage.getItem(KEY);
  } catch {
    return "/";
  }
  return id !== null && UUID.test(id) ? `/?thread=${id.toLowerCase()}` : "/";
}
