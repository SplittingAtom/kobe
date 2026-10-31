import type { Page } from "@playwright/test";
import { expect, test } from "./support/chat.js";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";
import { pageApi } from "./support/gate5.js";

/**
 * KOBE-531 ac-9 (spec MA3 as amended 2026-10-31): with an app placed in the artifact column by a
 * site admin, a rail launch opens the app's tab in the artifact column at once and its card in
 * the conversation shows "Opened in the side column".
 *
 * Signed in as the owner (site admin), it sets the app's placement through the admin API
 * (`PUT /v1/site/connectors/{id}/templates/placement`) and puts the previous one back in
 * `finally`. The app is `KOBE_PLACEMENT_APP` (its title in `GET /v1/team/apps`; default "Lake
 * Query", gate1's Catalyst app). Without it the spec skips, unless `KOBE_REQUIRE_APP=1`. One rail
 * launch (one call of the app's opening tool), no model tokens; it leaves a new thread behind.
 */
const TITLE = process.env["KOBE_PLACEMENT_APP"] ?? "Lake Query";

interface App {
  readonly appId: string;
  readonly connectorId: string;
  readonly connectorName: string;
  readonly title: string;
  readonly uri: string;
  readonly placement?: string;
}

async function theApp(page: Page): Promise<App | undefined> {
  const listed = await pageApi<{ apps?: App[] }>(page, "GET", "/v1/team/apps");
  expect(listed.status).toBe(200);
  return (listed.json.apps ?? []).find((a) => a.title === TITLE);
}

function place(page: Page, app: App, placement: string) {
  return pageApi(page, "PUT", `/v1/site/connectors/${app.connectorId}/templates/placement`, {
    uri: app.uri,
    placement,
  });
}

test("an app placed in the artifact column opens there from a rail launch; its card is the stub", async ({
  chat,
  page,
}) => {
  await chat.open();
  const app = await theApp(page);
  if (process.env["KOBE_REQUIRE_APP"] === "1") {
    expect(app, `KOBE_REQUIRE_APP=1: the member needs the ${TITLE} app`).toBeDefined();
  }
  test.skip(app === undefined, `${TITLE} is not live for this member in the active team.`);
  if (!app) return;
  const previous = app.placement ?? "chat";
  expect((await place(page, app, "artifacts")).status).toBe(200);
  try {
    // A fresh page reads the apps list (and their placement) again.
    await chat.open();
    await chat.showBothPanels("apps");
    await page
      .getByRole("tabpanel", { name: "Apps", exact: true })
      .getByTitle(`Open ${app.title} from ${app.connectorName} in a new conversation`, {
        exact: true,
      })
      .click();
    await chat.threadId();

    const tabs = page.getByRole("tablist", { name: "Open artifacts" });
    await expect(tabs.getByRole("tab", { name: app.title, selected: true })).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });
    const frameTitle = `${app.title} (app from ${app.connectorName})`;
    await expect(page.getByRole("tabpanel").locator(`iframe[title="${frameTitle}"]`)).toHaveCount(
      1,
      { timeout: SHELL_TIMEOUT_MS },
    );
    const card = page.locator("[data-kobe-app-card-entry]").last();
    await expect(card.getByText("Opened in the side column")).toBeVisible();
    // One live frame for the card: the column's, none in the conversation.
    await expect(chat.list.locator(`iframe[title="${frameTitle}"]`)).toHaveCount(0);
  } finally {
    expect((await place(page, app, previous)).status).toBe(200);
  }
});
