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
 * Opens `area` beside the thread, or closes it (undefined), as a new history entry, keeping the
 * thread and every other parameter. The chat follows the address (`popstate`), so this works from
 * outside the workspace too (the bar, the profile menu).
 */
export function showArea(area: AreaId | undefined): void {
  const url = new URL(window.location.href);
  if (areaFromUrl(url.search) === area) return;
  if (area === undefined) url.searchParams.delete(AREA_PARAM);
  else url.searchParams.set(AREA_PARAM, area);
  window.history.pushState(null, "", url);
  window.dispatchEvent(new PopStateEvent(AREA_EVENT));
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
