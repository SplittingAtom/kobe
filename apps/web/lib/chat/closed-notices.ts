/**
 * Chat notices this viewer closed (KOBE-468): egress and run notices, remembered per event in this
 * browser (localStorage, a per-viewer convenience like the artifact tabs). Blocked or garbled
 * storage means nothing is remembered; closing still hides the notice for this page view.
 */

const KEY = "kobe.chat.closedNotices";

/** The most recent closed notices kept; older ones may show again. */
export const CLOSED_NOTICES_MAX = 200;

const ID_MAX = 1024;

function readClosed(): readonly string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value
      .filter((id): id is string => typeof id === "string" && id !== "" && id.length <= ID_MAX)
      .slice(-CLOSED_NOTICES_MAX);
  } catch {
    return []; // storage blocked or garbled
  }
}

export function isNoticeClosed(id: string): boolean {
  return readClosed().includes(id);
}

export function closeNotice(id: string): void {
  const next = [...readClosed().filter((closed) => closed !== id), id].slice(-CLOSED_NOTICES_MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage blocked or full: the notice stays closed for this page only.
  }
}
