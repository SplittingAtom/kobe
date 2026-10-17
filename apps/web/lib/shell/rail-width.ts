/**
 * The rail's dragged width (KOBE-305): remembered in this browser (localStorage, like the
 * artifact tabs and the file tree's folders), read leniently and never trusted. Storage that is
 * blocked or full only means the width lasts for this page. `null` is the default (280 px).
 *
 * The grid reads it from {@link RAIL_WIDTH_VAR}; `shell.module.css` keeps the conversation's
 * floor (and the artifact column's, while it is open) whatever was stored, so a width chosen on a
 * wider window simply yields until the window grows again.
 */
import { RAIL_PX } from "./layout";

export const RAIL_WIDTH_KEY = "kobe.railWidth";

/** The shell grid's custom property for the expanded rail's dragged width. */
export const RAIL_WIDTH_VAR = "--kobe-rail-expanded-width";

/** One arrow key's step on the rail's handle, in px. */
export const RAIL_STEP_PX = 24;

/** A width within the rail's own bounds, in whole px; null when it isn't a finite number. */
export function railWidthWithin(width: unknown): number | null {
  if (typeof width !== "number" || !Number.isFinite(width)) return null;
  return Math.round(Math.min(RAIL_PX.max, Math.max(RAIL_PX.min, width)));
}

/** The stored width, if it is a whole number within the bounds; else null (the default). */
export function readRailWidth(
  storage: Pick<Storage, "getItem"> | undefined = local(),
): number | null {
  try {
    const raw = storage?.getItem(RAIL_WIDTH_KEY) ?? null;
    if (raw === null || !/^\d{1,4}$/.test(raw)) return null;
    const width = Number(raw);
    return width >= RAIL_PX.min && width <= RAIL_PX.max ? width : null;
  } catch {
    return null; // storage blocked: the default
  }
}

/** Remembers a width, or forgets it (`null`: back to the default). */
export function writeRailWidth(
  width: number | null,
  storage: Pick<Storage, "setItem" | "removeItem"> | undefined = local(),
): void {
  try {
    if (width === null) storage?.removeItem(RAIL_WIDTH_KEY);
    else storage?.setItem(RAIL_WIDTH_KEY, String(width));
  } catch {
    // Storage blocked or full: the width lasts for this page only.
  }
}

function local(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined; // some browsers throw on the accessor itself when storage is blocked
  }
}
