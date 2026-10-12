"use client";

import { useAuiEvent, useThreadViewportStore } from "@assistant-ui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { distanceFromBottom, isPinned, loadScroll, saveScroll } from "../../lib/chat/scroll-follow";

/**
 * CE9 on the message list (KOBE-205). assistant-ui's viewport `autoScroll` follows the stream while
 * the list is exactly at the bottom; this adds the rest:
 * - pinned means within 48 px of the bottom: content growth then scrolls to the bottom too;
 * - scrolling further up unpins (the caller shows the Jump to latest pill), sending re-pins;
 * - opening a thread restores the position this tab left it at, else lands at the bottom;
 * - every scroll of an opened thread is remembered for this tab (sessionStorage).
 *
 * Call inside `ThreadPrimitive.ViewportProvider`: its `scrollToBottom` reaches the viewport.
 * `ready` is true once the thread's messages are on screen.
 */
export function useFollowLatest(
  el: HTMLElement | null,
  threadId: string | null,
  ready: boolean,
): boolean {
  const viewport = useThreadViewportStore();
  const [pinned, setPinnedState] = useState(true);
  const pinnedRef = useRef(true);
  // The thread whose position has been restored; scrolls before that belong to the switch.
  const restoredRef = useRef<string | null | undefined>(undefined);

  const setPinned = useCallback((value: boolean) => {
    pinnedRef.current = value;
    setPinnedState(value);
  }, []);

  const toBottom = useCallback(
    (behavior: ScrollBehavior) => {
      setPinned(true);
      viewport.getState().scrollToBottom({ behavior });
    },
    [viewport, setPinned],
  );

  useEffect(() => {
    if (!el) return;
    const onScroll = () => {
      const now = isPinned(el);
      if (now !== pinnedRef.current) setPinned(now);
      if (threadId !== null && restoredRef.current === threadId) {
        saveScroll(threadId, now ? "bottom" : el.scrollTop);
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [el, threadId, setPinned]);

  // Growth while pinned but not exactly at the bottom (assistant-ui follows only from there).
  useEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current && distanceFromBottom(el) > 0) {
        el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
      }
    });
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [el]);

  useEffect(() => {
    if (!el || !ready || restoredRef.current === threadId) return;
    const saved = threadId === null ? null : loadScroll(threadId);
    // After the frame that lays the messages out, so the offset exists.
    const frame = requestAnimationFrame(() => {
      restoredRef.current = threadId;
      if (typeof saved === "number") {
        el.scrollTo({ top: saved, behavior: "instant" });
        setPinned(isPinned(el));
      } else {
        toBottom("instant");
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [el, ready, threadId, toBottom, setPinned]);

  // Any send re-pins: the thread's composer and an edited message alike.
  useAuiEvent({ scope: "*", event: "composer.send" }, () => toBottom("auto"));

  return pinned;
}
