import type { Page } from "@playwright/test";

/**
 * Launches an app from the composer's + menu (KOBE-451): Add to your message → Apps → the app.
 * The rail's Apps tab lists no apps since KOBE-559 (only the chosen picker), so this is the one
 * way a spec opens an app with chat or artifact placement.
 */
export async function launchFromPlusMenu(
  page: Page,
  app: { readonly title: string; readonly connectorName: string },
): Promise<void> {
  await page.getByRole("button", { name: "Add to your message" }).click();
  const menu = page.locator("[data-kobe-plus-menu]");
  await menu.getByRole("menuitem", { name: "Apps" }).click();
  await page
    .getByRole("menu", { name: "Apps" })
    .getByRole("menuitem", { name: new RegExp(`^${app.title}\\b.*${app.connectorName}`) })
    .click();
}
