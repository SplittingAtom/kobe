"use client";

import { useAuiEvent, useAuiState, useThreadViewportStore } from "@assistant-ui/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  createScrollSaver,
  distanceFromBottom,
  isPinned,
  loadScroll,
  overflows,
  scrollDirection,
  type ScrollMark,
} from "../../lib/chat/scroll-follow";

/**
 * Whether the message list follows new content. `pending` while a thread opens (until its position
 * is restored); then `pinned` or `unpinned`, which shows the Jump to latest pill.
 */
export type FollowMode = "pending" | "pinned" | "unpinned";

type Viewport = NonNullable<ReturnType<typeof useThreadViewportStore>>;

/**
 * CE9 on the message list (KOBE-205), driven through assistant-ui's viewport store: the caller
 * passes `autoScroll={mode === "pinned"}` to `ThreadPrimitive.Viewport`, so assistant-ui's own
 * resize observer does the following and nothing else scrolls on growth.
 * - Pinned: on any request for the bottom (the pill, a send, a restore), when the member scrolls
 *   down to within 48 px of the bottom (or to the bottom itself while the list grows), and when
 *   the list stops overflowing.
 * - Unpinned: as soon as the member scrolls up, however little (wheel, touch, keys, scrollbar).
 *   Nothing but the member pins it again (KOBE-288): not the list shrinking onto the member's
 *   position at a run's end, nor assistant-ui's last follow scroll in the frame before the
 *   unpinned mode reached it.
 * - Opening a thread restores this tab's position for it (sessionStorage), else the bottom.
 *
 * Call inside `ThreadPrimitive.ViewportProvider`. `ready`: the thread's messages are on screen.
 */
export function useFollowLatest(
  el: HTMLElement | null,
  threadId: string | null,
  ready: boolean,
): FollowMode {
  const viewport = useThreadViewportStore();
  const [mode, setModeState] = useState<FollowMode>("pending");
  const modeRef = useRef<FollowMode>("pending");
  // The mode assistant-ui has (`autoScroll`): it follows on resize until "unpinned" commits.
  const committedRef = useRef<FollowMode>("pending");
  useLayoutEffect(() => {
    committedRef.current = mode;
  }, [mode]);
  const threadRef = useRef(threadId);
  // The thread whose position has been restored; until then its scroll events are the switch's.
  const restoredRef = useRef<string | null | undefined>(undefined);
  const [saver] = useState(createScrollSaver);

  const setMode = useCallback((next: FollowMode) => {
    modeRef.current = next;
    setModeState(next);
  }, []);
  const isRestored = useCallback(() => restoredRef.current === threadRef.current, []);
  // Pinned first, so the scroll this causes is already recorded as the bottom.
  const requestBottom = useCallback(() => {
    setMode("pinned");
    viewport.getState().scrollToBottom({ behavior: "instant" });
  }, [viewport, setMode]);

  usePinOnRequest(viewport, el, setMode, modeRef);
  useMemberScroll(el, {
    setMode,
    requestBottom,
    modeRef,
    committedRef,
    threadRef,
    isRestored,
    saver,
  });

  // A thread switch: write the old thread's position at once, wait for the new one's restore.
  useEffect(() => {
    threadRef.current = threadId;
    if (restoredRef.current !== threadId) setMode("pending");
    return () => saver.flush();
  }, [threadId, saver, setMode]);

  useEffect(() => {
    if (!el || !ready || restoredRef.current === threadId) return;
    const saved = threadId === null ? null : loadScroll(threadId);
    // After the frame that lays the messages out, so the offset exists.
    const frame = requestAnimationFrame(() => {
      restoredRef.current = threadId;
      if (typeof saved === "number") {
        setMode("unpinned");
        el.scrollTo({ top: saved, behavior: "instant" });
        if (isPinned(el)) requestBottom();
      } else {
        requestBottom();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [el, ready, threadId, setMode, requestBottom]);

  useRepinOnSend(viewport);
  return mode;
}

/**
 * Any request for the bottom pins, and so does a list with nothing left to scroll. Merely being at
 * the bottom does not: the list can shrink onto a member who just scrolled up (KOBE-288).
 */
function usePinOnRequest(
  viewport: Viewport,
  el: HTMLElement | null,
  setMode: (mode: FollowMode) => void,
  modeRef: { readonly current: FollowMode },
) {
  useEffect(() => {
    const offRequest = viewport.getState().onScrollToBottom(() => setMode("pinned"));
    const offBottom = viewport.subscribe((state, prev) => {
      const fits = el !== null && !overflows(el);
      if (state.isAtBottom && !prev.isAtBottom && modeRef.current === "unpinned" && fits) {
        setMode("pinned");
      }
    });
    return () => {
      offRequest();
      offBottom();
    };
  }, [viewport, el, setMode, modeRef]);
}

interface MemberScrollState {
  readonly setMode: (mode: FollowMode) => void;
  readonly requestBottom: () => void;
  readonly modeRef: { readonly current: FollowMode };
  readonly committedRef: { readonly current: FollowMode };
  readonly threadRef: { readonly current: string | null };
  readonly isRestored: () => boolean;
  readonly saver: ReturnType<typeof createScrollSaver>;
}

/**
 * The member's own scrolling: up unpins at once; down into the 48 px band re-pins, and so does
 * reaching the bottom while the list grows. A move down while assistant-ui still follows (the
 * frame between an unpin and its render) is assistant-ui's, not the member's.
 */
function useMemberScroll(el: HTMLElement | null, s: MemberScrollState) {
  const { setMode, requestBottom, modeRef, committedRef, threadRef, isRestored, saver } = s;
  useEffect(() => {
    if (!el) return;
    let last: ScrollMark = { top: el.scrollTop, height: el.scrollHeight };
    let touchY: number | null = null;
    const unpin = () => {
      if (isRestored() && overflows(el)) setMode("unpinned");
    };
    const onScroll = () => {
      const now = { top: el.scrollTop, height: el.scrollHeight };
      const prev = last;
      const direction = scrollDirection(prev, now);
      last = now;
      if (!isRestored()) return;
      const byMember = modeRef.current === "unpinned" && committedRef.current === "unpinned";
      const reachedBottom = now.top > prev.top && distanceFromBottom(el) <= 1;
      if (direction === "up") setMode("unpinned");
      else if (byMember && ((direction === "down" && isPinned(el)) || reachedBottom)) {
        requestBottom();
      }
      const thread = threadRef.current;
      if (thread !== null)
        saver.schedule(thread, modeRef.current === "pinned" ? "bottom" : now.top);
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) unpin();
    };
    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY;
      // A finger moving down drags the content down: the member is scrolling up.
      if (touchY !== null && y !== undefined && y > touchY) unpin();
    };
    const options = { passive: true } as const;
    el.addEventListener("scroll", onScroll, options);
    el.addEventListener("wheel", onWheel, options);
    el.addEventListener("touchstart", onTouchStart, options);
    el.addEventListener("touchmove", onTouchMove, options);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
    };
  }, [el, setMode, requestBottom, modeRef, committedRef, threadRef, isRestored, saver]);
}

/**
 * Sending re-pins: at once, and again when the sent message has rendered (the list grew after the
 * first jump). Instant, so `scroll-smooth` never animates towards a bottom that has since moved.
 * assistant-ui delivers `composer.send` in a microtask, usually after the message has rendered
 * (the thread runs at once); only a send that has not rendered yet (a new thread is created
 * first) waits for the next render. A wait left open would re-pin at the run's end, when the
 * answer's placeholder goes, over the member's scroll up (KOBE-288).
 */
function useRepinOnSend(viewport: Viewport) {
  const count = useAuiState((s) => s.thread.messages.length);
  const running = useAuiState((s) => s.thread.isRunning);
  const runningRef = useRef(running);
  useLayoutEffect(() => {
    runningRef.current = running;
  }, [running]);
  const awaitingRender = useRef(false);
  useAuiEvent({ scope: "*", event: "composer.send" }, () => {
    awaitingRender.current = !runningRef.current;
    viewport.getState().scrollToBottom({ behavior: "instant" });
  });
  useEffect(() => {
    if (!awaitingRender.current) return;
    awaitingRender.current = false;
    viewport.getState().scrollToBottom({ behavior: "instant" });
  }, [count, viewport]);
}
