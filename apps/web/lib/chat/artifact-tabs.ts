/**
 * The artifact column's tabs and width (CE6, CE7, KOBE-200), kept free of React. The open set and
 * the active tab are remembered per thread in this browser (localStorage, CE6: transient state);
 * missing, blocked or garbled storage reads as no tabs. Every function returns a new value.
 */

export interface ArtifactTabs {
  /** Artifact ids in order of opening. */
  readonly open: readonly string[];
  /** One of `open`, or null when nothing is open. */
  readonly active: string | null;
}

export const NO_TABS: ArtifactTabs = { open: [], active: null };

/** More than this and the oldest tab closes: a thread rarely has this many artifacts. */
export const MAX_TABS = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Opens `id` (at the end, unless it is open already) and makes it active. */
export function openTab(tabs: ArtifactTabs, id: string): ArtifactTabs {
  if (tabs.open.includes(id)) return tabs.active === id ? tabs : { ...tabs, active: id };
  const open = [...tabs.open, id];
  return { open: open.slice(Math.max(0, open.length - MAX_TABS)), active: id };
}

export function activateTab(tabs: ArtifactTabs, id: string): ArtifactTabs {
  return tabs.open.includes(id) && tabs.active !== id ? { ...tabs, active: id } : tabs;
}

/** Closes `id`; when it was active, its right neighbour (or else its left) becomes active. */
export function closeTab(tabs: ArtifactTabs, id: string): ArtifactTabs {
  const index = tabs.open.indexOf(id);
  if (index < 0) return tabs;
  const open = tabs.open.filter((t) => t !== id);
  if (tabs.active !== id) return { ...tabs, open };
  return { open, active: open[Math.min(index, open.length - 1)] ?? null };
}

/** Drops tabs of artifacts that no longer exist (the thread's list is the record). */
export function retainTabs(tabs: ArtifactTabs, existing: ReadonlySet<string>): ArtifactTabs {
  const open = tabs.open.filter((id) => existing.has(id));
  if (open.length === tabs.open.length) return tabs;
  return normalise(open, tabs.active);
}

function normalise(open: readonly string[], active: unknown): ArtifactTabs {
  if (open.length === 0) return NO_TABS;
  const kept = typeof active === "string" && open.includes(active) ? active : open.at(-1);
  return { open, active: kept ?? null };
}

const KEY_PREFIX = "kobe.artifactTabs:";

export function tabsKey(teamId: string, threadId: string): string {
  return `${KEY_PREFIX}${teamId}:${threadId}`;
}

/** The remembered tabs of one thread; anything unreadable is no tabs. */
export function readTabs(key: string): ArtifactTabs {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return NO_TABS; // storage blocked
  }
  if (raw === null) return NO_TABS;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return NO_TABS;
  }
  if (typeof value !== "object" || value === null) return NO_TABS;
  const { open, active } = value as Record<string, unknown>;
  if (!Array.isArray(open)) return NO_TABS;
  const ids = [
    ...new Set(open.filter((id): id is string => typeof id === "string" && UUID.test(id))),
  ];
  return normalise(ids.slice(Math.max(0, ids.length - MAX_TABS)), active);
}

/** Remembers a thread's tabs; no tabs forgets the thread. Blocked storage is ignored. */
export function writeTabs(key: string, tabs: ArtifactTabs): void {
  try {
    if (tabs.open.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ open: tabs.open, active: tabs.active }));
  } catch {
    // Storage blocked or full: the tabs last for this page only.
  }
}

/** CE7: the artifact column never under 360 px, the conversation never under 400 px. */
export const ARTIFACT_FLOOR_PX = 360;
export const CONVERSATION_FLOOR_PX = 400;

/** The shell grid's custom property for a dragged width (`components/shell/shell.module.css`). */
export const ARTIFACT_WIDTH_VAR = "--kobe-artifact-width";

/** The widest the artifact column may be when the two columns share `available` px. */
export function maxArtifactWidth(available: number): number {
  return Math.max(ARTIFACT_FLOOR_PX, Math.round(available) - CONVERSATION_FLOOR_PX);
}

/**
 * A width that holds both floors in `available` px (the space right of the rail). When the two
 * floors don't both fit, the artifact floor wins here; A5 (KOBE-201) turns the column into an
 * overlay sheet at those widths.
 */
export function clampArtifactWidth(width: number, available: number): number {
  const max = maxArtifactWidth(available);
  if (!Number.isFinite(width)) return Math.max(ARTIFACT_FLOOR_PX, Math.min(max, available / 2));
  return Math.round(Math.min(max, Math.max(ARTIFACT_FLOOR_PX, width)));
}
