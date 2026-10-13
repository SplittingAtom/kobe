/**
 * The shell's breakpoints and yield order (CE7, CE8, KOBE-201). As the window narrows: the rail
 * collapses to 48 px, then the artifact column shrinks to its 360 px floor, then it becomes an
 * overlay sheet over the conversation, and under 768 px everything is one column (the rail a
 * drawer, artifacts a full-screen sheet). The conversation never gets under 400 px beside them.
 *
 * `shell.module.css` lays this out with media queries on the same numbers; `layoutAt` states the
 * same rules as arithmetic, so tests can check the table without a layout engine.
 */
import { ARTIFACT_FLOOR_PX, CONVERSATION_FLOOR_PX } from "../chat/artifact-tabs";

/** Lower edge of each band, in CSS px. */
export const BREAKPOINTS = { overlay: 768, medium: 820, wide: 1100 } as const;

export const RAIL_PX = { expanded: 280, collapsed: 48 } as const;

/**
 * - `wide` (≥ 1100): rail, artifact column, conversation; the member's sizes are honoured;
 * - `medium` (820–1100): the rail is collapsed (expanding it opens a drawer), the column shrinks;
 * - `overlay` (768–820): the artifact column is a sheet over the conversation;
 * - `single` (< 768): one column (CE8).
 */
export type ShellBand = "wide" | "medium" | "overlay" | "single";

export const BAND_QUERIES = {
  wide: `(min-width: ${BREAKPOINTS.wide}px)`,
  medium: `(min-width: ${BREAKPOINTS.medium}px)`,
  overlay: `(min-width: ${BREAKPOINTS.overlay}px)`,
} as const;

export function bandFromMatches(m: {
  readonly wide: boolean;
  readonly medium: boolean;
  readonly overlay: boolean;
}): ShellBand {
  if (m.wide) return "wide";
  if (m.medium) return "medium";
  return m.overlay ? "overlay" : "single";
}

export function bandFor(width: number): ShellBand {
  return bandFromMatches({
    wide: width >= BREAKPOINTS.wide,
    medium: width >= BREAKPOINTS.medium,
    overlay: width >= BREAKPOINTS.overlay,
  });
}

/** The rail keeps its own width (the member's choice) only on wide windows. */
export const railDocked = (band: ShellBand): boolean => band === "wide";

/** Artifacts open as a sheet (overlay or full screen) rather than a column. */
export const artifactAsSheet = (band: ShellBand): boolean =>
  band === "overlay" || band === "single";

export type ArtifactMode = "none" | "column" | "overlay" | "sheet";

export interface LayoutInput {
  readonly width: number;
  /** The member's choice for the rail (applies on wide windows only). */
  readonly railCollapsed: boolean;
  readonly artifactOpen: boolean;
  /** A dragged width in px; null is the default, half the space right of the rail. */
  readonly artifactWidth: number | null;
}

export interface ShellLayout {
  readonly band: ShellBand;
  /** The rail's column in px (0: one column, the rail is a drawer). */
  readonly rail: number;
  readonly artifactMode: ArtifactMode;
  /** The artifact column in px; 0 unless it is a column. */
  readonly artifact: number;
  readonly conversation: number;
}

function artifactModeOf(band: ShellBand, open: boolean): ArtifactMode {
  if (!open) return "none";
  if (band === "single") return "sheet";
  return band === "overlay" ? "overlay" : "column";
}

/** The columns' widths at `width`, as `shell.module.css` lays them out. */
export function layoutAt({
  width,
  railCollapsed,
  artifactOpen,
  artifactWidth,
}: LayoutInput): ShellLayout {
  const band = bandFor(width);
  const rail =
    band === "single"
      ? 0
      : railDocked(band) && !railCollapsed
        ? RAIL_PX.expanded
        : RAIL_PX.collapsed;
  const artifactMode = artifactModeOf(band, artifactOpen);
  const space = width - rail;
  if (artifactMode !== "column") {
    return { band, rail, artifactMode, artifact: 0, conversation: space };
  }
  // minmax(360px, min(var(--kobe-artifact-width), 100% - rail - 400px)) minmax(400px, 1fr)
  const wanted = artifactWidth ?? space / 2;
  const artifact = Math.max(ARTIFACT_FLOOR_PX, Math.min(wanted, space - CONVERSATION_FLOOR_PX));
  return { band, rail, artifactMode, artifact, conversation: space - artifact };
}
