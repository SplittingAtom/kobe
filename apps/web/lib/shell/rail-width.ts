/**
 * The rail's dragged width (KOBE-305): a per-user layout preference, server-side like the artifact
 * column's width (CE8, `rail_width` in `lib/shell/preferences.ts`), so it follows the member across
 * devices. `null` is the default (280 px).
 *
 * The grid reads it from {@link RAIL_WIDTH_VAR}; `shell.module.css` keeps the conversation's floor
 * (and the artifact column's, while it is open) whatever was stored, so a width chosen on a wider
 * window simply yields until the window grows again.
 */
import { RAIL_PX } from "./layout";

/** The shell grid's custom property for the expanded rail's dragged width. */
export const RAIL_WIDTH_VAR = "--kobe-rail-expanded-width";

/** One arrow key's step on the rail's handle, in px. */
export const RAIL_STEP_PX = 24;

/** A width within the rail's own bounds, in whole px; null when it isn't a finite number. */
export function railWidthWithin(width: unknown): number | null {
  if (typeof width !== "number" || !Number.isFinite(width)) return null;
  return Math.round(Math.min(RAIL_PX.max, Math.max(RAIL_PX.min, width)));
}

/** The stored width if it is within the rail's bounds, else null (the default applies). */
export function applyRailWidth(stored: number | null | undefined): number | null {
  if (stored === null || stored === undefined || !Number.isInteger(stored)) return null;
  return stored >= RAIL_PX.min && stored <= RAIL_PX.max ? stored : null;
}

/**
 * The rail's width while a picker shows in its Apps tab (KOBE-460, spec MA3 as amended
 * 2026-10-20): at least this, when the window allows (the grid keeps the conversation's floor);
 * a member's wider width stays. Never saved: None brings the member's own width back.
 */
export const PICKER_RAIL_PX = 400;

/** The width the grid shows: the member's, widened for a picker (null: the 280 px default). */
export function shownRailWidth(member: number | null, picker: boolean): number | null {
  if (!picker) return member;
  return Math.max(member ?? RAIL_PX.expanded, PICKER_RAIL_PX);
}
