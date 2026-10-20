import type { Locator, Page } from "@playwright/test";

/**
 * The panel over the workspace (KOBE-452): every console and My area page opens in it, with the
 * chat mounted (and inert) behind it, so a page's queries are scoped here, never page-wide.
 */
export function panelOf(page: Page): Locator {
  return page.locator("[data-kobe-panel]");
}
