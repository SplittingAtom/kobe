"use client";

import { useSyncExternalStore } from "react";
import {
  effectiveTheme,
  OS_DARK_QUERY,
  otherTheme,
  parseTheme,
  themeCookie,
  type Theme,
} from "../../lib/theme/theme";

/** The saved choice, from `<html data-theme>` (set by the root layout from the cookie). */
function chosenTheme(): Theme | null {
  return parseTheme(document.documentElement.dataset.theme);
}

/** One list for the page, shared by `subscribe` and the snapshot; made on first use (never on
 * the server). `undefined` until then, `null` where matchMedia is missing. */
let osList: MediaQueryList | null | undefined;

function osQuery(): MediaQueryList | null {
  if (osList === undefined) {
    osList = typeof window.matchMedia === "function" ? window.matchMedia(OS_DARK_QUERY) : null;
  }
  return osList;
}

/** Tests replace `matchMedia` between cases: forget the cached list. */
export function resetThemeQueryForTests(): void {
  osList = undefined;
}

function currentTheme(): Theme {
  return effectiveTheme(chosenTheme(), osQuery()?.matches === true);
}

/** Re-reads on a new choice (any toggle on the page) and on an OS switch while nothing is saved. */
function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ["data-theme"] });
  const query = osQuery();
  query?.addEventListener?.("change", onChange);
  return () => {
    observer.disconnect();
    query?.removeEventListener?.("change", onChange);
  };
}

/**
 * The theme on screen (KOBE-282), or null on the server and during hydration: the server cannot
 * know the OS setting, so markup that depends on it waits for the client (the CSS already paints
 * the right theme).
 */
export function useTheme(): Theme | null {
  return useSyncExternalStore<Theme | null>(subscribe, currentTheme, () => null);
}

/** Saves the other theme: on `<html>` now, in the cookie for the next page load. */
export function toggleTheme(): Theme {
  const next = otherTheme(currentTheme());
  document.documentElement.dataset.theme = next;
  document.cookie = themeCookie(next, window.location.protocol === "https:");
  return next;
}
