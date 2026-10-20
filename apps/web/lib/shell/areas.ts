/**
 * The My area pages that KOBE-424 (CE4, U18) opened beside the thread with `?area=<id>`: memory,
 * approvals, the schedules list and the member's connector settings. Since KOBE-452 every page
 * outside the chat opens as a panel over the workspace at its own address (`lib/shell/panels.ts`),
 * so `/?thread=…&area=memory` links from before are sent on to `/me/memory`.
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

/** The area an older address names (`?area=`), if it names one. */
export function areaFromUrl(search: string = currentSearch()): AreaId | undefined {
  const value = new URLSearchParams(search).get(AREA_PARAM);
  return isArea(value) ? value : undefined;
}

function currentSearch(): string {
  return typeof window === "undefined" ? "" : window.location.search;
}

/** True on the chat itself, with no panel over it (KOBE-452). */
export function onChatPage(): boolean {
  return typeof window !== "undefined" && window.location.pathname === "/";
}
