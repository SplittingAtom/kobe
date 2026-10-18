/**
 * The member's own pages that open beside the thread (CE4, U18, KOBE-424): "Artifacts, files,
 * memory panel, approvals, search results, thread settings, schedules list, profile and settings
 * open beside the thread." Of the My area pages that is memory, approvals, the schedules list and
 * the member's connector settings. The agent and skill builders keep full pages (CE4), and so do
 * Projects and My shared cases, which CE4 does not name (the narrower reading).
 *
 * In the chat, `?area=<id>` beside `?thread=` says which one is open, so a link, a refresh and
 * Back/Forward keep it. The `/me/...` routes stay: a new tab, or a link from a console, opens the
 * full page.
 */
export const AREA_PARAM = "area";

export const AREAS = {
  memory: { name: "My memory", href: "/me/memory" },
  approvals: { name: "My approvals", href: "/me/approvals" },
  schedules: { name: "My schedules", href: "/me/schedules" },
  connectors: { name: "My connectors", href: "/me/connectors" },
} as const;

export type AreaId = keyof typeof AREAS;

const isArea = (value: string | null | undefined): value is AreaId =>
  value !== null && value !== undefined && Object.hasOwn(AREAS, value);

/** The area a `/me/...` link opens beside the thread; undefined for any other link. */
export function areaOfHref(href: string): AreaId | undefined {
  const path = href.split(/[?#]/)[0];
  return (Object.keys(AREAS) as AreaId[]).find((id) => AREAS[id].href === path);
}

/** The area open in this address (`?area=`), if it names one. */
export function areaFromUrl(search: string = currentSearch()): AreaId | undefined {
  const value = new URLSearchParams(search).get(AREA_PARAM);
  return isArea(value) ? value : undefined;
}

function currentSearch(): string {
  return typeof window === "undefined" ? "" : window.location.search;
}

/** Event the chat's area panel follows; the URL changed through `history`. */
const AREA_EVENT = "popstate";

/**
 * Kept in the history entry of an opened page: the address it was opened from (the thread
 * without the page). Next's own entry state is kept alongside (its `pushState` patch copies it).
 */
const OPENED_FROM = "kobeAreaOpenedFrom";

function entryState(): Record<string, unknown> {
  const state: unknown = window.history.state;
  return state !== null && typeof state === "object"
    ? { ...(state as Record<string, unknown>) }
    : {};
}

function follow(): void {
  window.dispatchEvent(new PopStateEvent(AREA_EVENT));
}

/**
 * Opens `area` beside the thread, keeping the thread and every other parameter; the chat follows
 * the address (`popstate`), so this works from outside the workspace too (the bar, the profile
 * menu). From the conversation it is a new history entry (Back closes it); from another page
 * beside the thread it takes that entry's place (Back still returns to the conversation).
 * `undefined` closes it: see {@link closeArea}.
 */
export function showArea(area: AreaId | undefined): void {
  const url = new URL(window.location.href);
  const open = areaFromUrl(url.search);
  if (open === area) return;
  if (area === undefined) {
    closeArea();
    return;
  }
  url.searchParams.set(AREA_PARAM, area);
  if (open === undefined) {
    window.history.pushState({ ...entryState(), [OPENED_FROM]: window.location.href }, "", url);
  } else {
    window.history.replaceState(entryState(), "", url);
  }
  follow();
}

/**
 * Closes the page beside the thread. Opened from the conversation in this tab, it goes Back to
 * that entry, so the browser's Back never reopens what was just closed (a trap on phones, where
 * the sheet has its own Back). Opened by a link or a refresh, its entry becomes the conversation.
 */
export function closeArea(): void {
  const url = new URL(window.location.href);
  if (areaFromUrl(url.search) === undefined) return;
  url.searchParams.delete(AREA_PARAM);
  const { [OPENED_FROM]: openedFrom, ...state } = entryState();
  if (openedFrom === url.href) {
    window.history.back(); // the browser's popstate updates the chat
    return;
  }
  window.history.replaceState(state, "", url);
  follow();
}

/** True on the chat page, where the areas open beside the thread instead of as pages. */
export function onChatPage(): boolean {
  return typeof window !== "undefined" && window.location.pathname === "/";
}

/**
 * A link to a `/me/...` page that CE4 puts beside the thread, opened there when on the chat
 * page. Returns false (the caller navigates as usual) for any other link or page.
 */
export function openBeside(href: string): boolean {
  const area = areaOfHref(href);
  if (area === undefined || !onChatPage()) return false;
  showArea(area);
  return true;
}

/** A plain left click without modifier keys: anything else keeps the browser's own handling. */
export function plainClick(e: {
  readonly button: number;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}
