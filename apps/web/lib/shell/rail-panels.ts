import type { RailPanels } from "@kobe/protocol";

/**
 * The rail's panels (KOBE-419): Threads, Files, or both (the default). The member turns each on or
 * off from the rail's top line; the last one on stays on, so the rail always shows something.
 */
export type RailPanel = "threads" | "files";

export const DEFAULT_RAIL_PANELS: RailPanels = "both";

/** The last panel on can't be turned off: its toggle says why. */
export const LAST_PANEL_REASON = "At least one panel stays on.";

export function shows(panels: RailPanels, panel: RailPanel): boolean {
  return panels === "both" || panels === panel;
}

export function isLastPanel(panels: RailPanels, panel: RailPanel): boolean {
  return panels === panel;
}

/** `panels` with `panel` turned on or off; unchanged when that would leave none. */
export function withPanel(panels: RailPanels, panel: RailPanel, on: boolean): RailPanels {
  const other: RailPanel = panel === "threads" ? "files" : "threads";
  if (on) return shows(panels, other) ? "both" : panel;
  if (!shows(panels, panel) || isLastPanel(panels, panel)) return panels;
  return other;
}
