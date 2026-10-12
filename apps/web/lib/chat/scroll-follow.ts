/**
 * The follow rules of the message list (CE9, KOBE-205), kept free of React so they can be tested
 * without a layout engine. `components/chat/use-follow.ts` applies them to the viewport.
 */

/** New content keeps the view at the bottom while the member is this close to it. */
export const PIN_DISTANCE_PX = 48;

interface ScrollBox {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export function distanceFromBottom(el: ScrollBox): number {
  return Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
}

/** Close enough to the bottom to re-pin when the member scrolls down (never unpins on its own). */
export function isPinned(el: ScrollBox): boolean {
  return distanceFromBottom(el) <= PIN_DISTANCE_PX;
}

export function overflows(el: ScrollBox): boolean {
  return el.scrollHeight > el.clientHeight + 1;
}

/** Where the list was at the last scroll event. */
export interface ScrollMark {
  readonly top: number;
  readonly height: number;
}

/**
 * Which way the member moved the list. Only a move over unchanged content counts (assistant-ui's
 * `isUserScrollUp` rule): growth, shrinking and scroll anchoring change the height as well.
 */
export function scrollDirection(prev: ScrollMark, now: ScrollMark): "up" | "down" | null {
  if (now.height !== prev.height || now.top === prev.top) return null;
  return now.top < prev.top ? "up" : "down";
}

interface CountedMessage {
  readonly metadata?: { readonly isOptimistic?: boolean | undefined } | undefined;
}

/**
 * Messages on screen, without assistant-ui's empty placeholder for a reply that hasn't started.
 * Counted by position, not id: a live message keeps its place when Pi commits it under a new id.
 */
export function shownCount(messages: readonly CountedMessage[]): number {
  return messages.filter((m) => m.metadata?.isOptimistic !== true).length;
}

/** The pill's count: messages added since the member scrolled away from the bottom. */
export function newSince(countAtUnpin: number, countNow: number): number {
  return Math.max(0, countNow - countAtUnpin);
}

/** Where a thread was left: a scroll offset, or the bottom (so a reopened thread shows what's new). */
export type SavedScroll = number | "bottom";

const KEY_PREFIX = "kobe.scroll:";
const BOTTOM = "bottom";

/** Remembers the position for this tab. Storage can be missing or full: then nothing is kept. */
export function saveScroll(threadId: string, position: SavedScroll): void {
  const value = position === BOTTOM ? BOTTOM : String(Math.round(position));
  try {
    sessionStorage.setItem(KEY_PREFIX + threadId, value);
  } catch {
    // No storage (private mode, blocked site data): the thread opens at the bottom instead.
  }
}

export function loadScroll(threadId: string): SavedScroll | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(KEY_PREFIX + threadId);
  } catch {
    return null;
  }
  if (raw === null) return null;
  if (raw === BOTTOM) return BOTTOM;
  const top = Number(raw);
  return Number.isFinite(top) && top >= 0 ? top : null;
}

/** Saves are coalesced: one write after scrolling settles, or at once when the thread is left. */
export const SAVE_DELAY_MS = 200;

export interface ScrollSaver {
  schedule(threadId: string, position: SavedScroll): void;
  flush(): void;
}

export function createScrollSaver(delayMs = SAVE_DELAY_MS): ScrollSaver {
  let pending: { readonly threadId: string; readonly position: SavedScroll } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (pending) saveScroll(pending.threadId, pending.position);
    pending = null;
  };
  return {
    schedule(threadId, position) {
      if (pending && pending.threadId !== threadId) flush();
      pending = { threadId, position };
      clearTimeout(timer);
      timer = setTimeout(flush, delayMs);
    },
    flush,
  };
}
