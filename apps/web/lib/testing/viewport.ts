import { act } from "@testing-library/react";

/** The width tests run at (vitest.config.ts): the shell's wide band (CE7). */
export const DESKTOP_WIDTH = 1280;

interface HappyDomWindow {
  readonly happyDOM?: { setViewport(viewport: { readonly width: number }): void };
}

/**
 * Resizes happy-dom's window: `matchMedia` answers for the new width and `resize` fires, so the
 * shell's band follows (KOBE-201). Call `resizeWindow(DESKTOP_WIDTH)` after the test.
 */
export function resizeWindow(width: number): void {
  const happy = (window as unknown as HappyDomWindow).happyDOM;
  if (!happy) throw new Error("resizeWindow needs the happy-dom environment");
  act(() => happy.setViewport({ width }));
}
