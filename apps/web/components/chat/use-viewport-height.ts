"use client";

import { useEffect } from "react";

const HEIGHT = "--kobe-viewport-height";
const OFFSET = "--kobe-viewport-offset";

/**
 * Keeps the chat on what the member can see (KOBE-205, CE9), so the composer sits above the
 * on-screen keyboard where the browser ignores `interactive-widget` (Safari on iOS): sets
 * `--kobe-viewport-height` and `--kobe-viewport-offset` on `el` from visualViewport (iOS pans the
 * visual viewport down by `offsetTop` when the keyboard opens). While pinch-zoomed both are
 * dropped, so zooming never squeezes the layout; without visualViewport, CSS uses 100dvh.
 */
export function useViewportHeight(el: HTMLElement | null): void {
  useEffect(() => {
    const vv = typeof window === "undefined" ? undefined : window.visualViewport;
    if (!el || !vv) return;
    const clear = () => {
      el.style.removeProperty(HEIGHT);
      el.style.removeProperty(OFFSET);
    };
    const update = () => {
      if (vv.scale > 1) return clear();
      el.style.setProperty(HEIGHT, `${Math.round(vv.height)}px`);
      el.style.setProperty(OFFSET, `${Math.max(0, Math.round(vv.offsetTop))}px`);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      clear();
    };
  }, [el]);
}
