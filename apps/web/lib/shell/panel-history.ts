/**
 * Where a panel over the workspace (KOBE-452) goes back to when it closes. Opened from the chat in
 * this tab, Close returns to that very history entry (`history.go(-n)`, past any steps taken inside
 * the panel), so the browser's Back never reopens what was just closed; opened by a link, a new
 * tab or a reload without that entry, Close replaces the panel's entry with the chat instead.
 *
 * The chat entry is the Navigation API's current entry while the chat (no panel) is on screen,
 * kept per tab in sessionStorage so a reload of the panel still finds it. Without the Navigation
 * API (or storage), `stepsBackToWorkspace` answers null and Close replaces.
 */
const KEY = "kobe.panelOrigin";

interface NavEntry {
  readonly key: string;
  readonly index: number;
}

/** The part of the Navigation API used here. */
export interface NavigationLike {
  readonly currentEntry: NavEntry | null;
  entries(): readonly NavEntry[];
  addEventListener(type: "currententrychange", listener: () => void): void;
  removeEventListener(type: "currententrychange", listener: () => void): void;
}

function navigationApi(): NavigationLike | undefined {
  if (typeof window === "undefined") return undefined;
  const nav = (window as unknown as { readonly navigation?: NavigationLike }).navigation;
  return nav && typeof nav.entries === "function" ? nav : undefined;
}

function stored(): NavEntry | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { key, index } = value as Record<string, unknown>;
    return typeof key === "string" && typeof index === "number" ? { key, index } : null;
  } catch {
    return null;
  }
}

/** Records the current entry as the chat a panel returns to. */
function noteCurrentEntry(nav: NavigationLike): void {
  const at = nav.currentEntry;
  if (!at) return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ key: at.key, index: at.index }));
  } catch {
    // Storage blocked: Close replaces instead of going back.
  }
}

/**
 * Follows the history while mounted: each entry the chat shows without a panel (`onChat` reads
 * the address) becomes the one a panel returns to. Returns the undo.
 */
export function followWorkspaceEntries(onChat: () => boolean): () => void {
  const nav = navigationApi();
  if (!nav) return () => {};
  const note = () => {
    if (onChat()) noteCurrentEntry(nav);
  };
  note();
  nav.addEventListener("currententrychange", note);
  return () => nav.removeEventListener("currententrychange", note);
}

/**
 * How many entries Back the chat a panel was opened from is, as a negative delta for
 * `history.go`; null when this panel wasn't opened from the chat in this tab's history.
 */
export function stepsBackToWorkspace(): number | null {
  const nav = navigationApi();
  const at = nav?.currentEntry;
  const origin = stored();
  if (!nav || !at || !origin || origin.index >= at.index) return null;
  if (nav.entries()[origin.index]?.key !== origin.key) return null;
  return origin.index - at.index;
}
