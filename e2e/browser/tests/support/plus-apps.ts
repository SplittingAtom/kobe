import type { Page } from "@playwright/test";

/**
 * Launches an app from the composer's + menu (KOBE-451): Add to your message → Apps → the app,
 * picked by its id (`data-kobe-app`), since a gate's connectors may offer several apps with one
 * title. The rail's Apps tab lists no apps since KOBE-559 (only the chosen picker), so this is
 * the one way a spec opens an app with chat or artifact placement.
 */
export async function launchFromPlusMenu(
  page: Page,
  app: { readonly appId: string },
): Promise<void> {
  await page.getByRole("button", { name: "Add to your message" }).click();
  await page.locator("[data-kobe-plus-menu]").getByRole("menuitem", { name: "Apps" }).click();
  await page
    .getByRole("menu", { name: "Apps" })
    .locator(`[role="menuitem"][data-kobe-app="${app.appId}"]`)
    .click();
}
