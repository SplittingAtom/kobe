import type { Locator, Page } from "@playwright/test";

/** Next.js's route announcer: a `role="alert"` live region in a shadow root on every page. */
const NEXT_ROUTE_ANNOUNCER = "#__next-route-announcer__";

/**
 * The page's own alerts (KOBE-306): `role="alert"` elements that say something, leaving out
 * Next.js's route announcer. The announcer is always on the page, empty after a full load and
 * holding the new page's title after a client navigation, so counting every alert fails a
 * healthy page. Use it wherever a spec asserts there is no alert: `toHaveCount(0)`.
 */
export function pageAlerts(scope: Page | Locator): Locator {
  return scope
    .getByRole("alert")
    .filter({ hasText: /\S/ })
    .and(scope.locator(`:not(${NEXT_ROUTE_ANNOUNCER})`));
}
