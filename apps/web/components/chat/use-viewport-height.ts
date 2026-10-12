"use client";

import { useEffect } from "react";

const VAR = "--kobe-viewport-height";

/**
 * Keeps the chat as tall as what the member can see (KOBE-205, CE9), so the composer sits above
 * the on-screen keyboard where the browser ignores `interactive-widget` (Safari on iOS): sets
 * `--kobe-viewport-height` on `el` from visualViewport. While pinch-zoomed the variable is
 * dropped, so zooming never squeezes the layout; without visualViewport, CSS falls back to 100dvh.
 */
export function useViewportHeight(el: HTMLElement | null): void {
  useEffect(() => {
    const vv = typeof window === "undefined" ? undefined : window.visualViewport;
    if (!el || !vv) return;
    const update = () => {
      if (vv.scale > 1) el.style.removeProperty(VAR);
      else el.style.setProperty(VAR, `${Math.round(vv.height)}px`);
    };
    update();
    vv.addEventListener("resize", update);
    return () => {
      vv.removeEventListener("resize", update);
      el.style.removeProperty(VAR);
    };
  }, [el]);
}
