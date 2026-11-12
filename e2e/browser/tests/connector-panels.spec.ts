import { expect, test, type Locator } from "@playwright/test";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";
import { panelOf } from "./support/panel.js";

/**
 * KOBE-639/640/641 on a real connector (gate1: Catalyst, `catalyst_2`, enabled for Team1, three
 * pinned and approved ui:// templates). `KOBE_USER` is the site Owner and a team admin of the
 * active team; `KOBE_CONNECTOR` names the connector (default `catalyst_2`). Read-only: it changes
 * nothing and spends no model tokens. Run on gate1: `npx playwright test connector-panels`.
 */
const NAME = process.env["KOBE_CONNECTOR"] ?? "catalyst_2";
const UI_TITLE = /^Opens an app: ui:\/\/\S+ \(/;

async function badgeTitles(scope: Locator): Promise<string[]> {
  const badges = scope.locator('[data-slot="console-badge"][title^="Opens an app: "]');
  return badges.evaluateAll((els) => els.map((e) => e.getAttribute("title") ?? ""));
}

test("team Connectors: tools in Read only and Write columns, MCP-UI badges (KOBE-639, 640)", async ({
  page,
}) => {
  await page.goto("/admin/team/connectors");
  const card = panelOf(page).getByRole("article", { name: NAME });
  await expect(card).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  const readOnly = card.getByRole("region", { name: `Read only tools of ${NAME}` });
  const write = card.getByRole("region", { name: `Write tools of ${NAME}` });
  await expect(readOnly.getByRole("heading", { name: /^Read only \(\d+\)$/ })).toBeVisible();
  await expect(write.getByRole("heading", { name: /^Write \(\d+\)$/ })).toBeVisible();
  // Every tool sits in exactly one column.
  const total = await card.getByRole("listitem").count();
  const split =
    (await readOnly.getByRole("listitem").count()) + (await write.getByRole("listitem").count());
  expect(split).toBe(total);
  // gate1's Catalyst has three ui:// templates, so at least one tool opens an app.
  const titles = await badgeTitles(card);
  expect(titles.length).toBeGreaterThan(0);
  for (const t of titles) expect(t).toMatch(UI_TITLE);
  await expect(card.getByText("MCP-UI").first()).toBeVisible();

  // Narrow: the columns stack, Write below Read only.
  await page.setViewportSize({ width: 600, height: 900 });
  const a = await readOnly.boundingBox();
  const b = await write.boundingBox();
  expect(a && b && b.y >= a.y + a.height - 1).toBe(true);
});

test("site registry: the connector name opens a detail panel with every tool (KOBE-641)", async ({
  page,
}) => {
  await page.goto("/admin/site/connectors");
  const name = panelOf(page).getByRole("button", { name: NAME, exact: true });
  await expect(name).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  const teams = page.waitForResponse(
    (r) => r.request().method() === "GET" && /\/v1\/site\/connectors\/[^/]+\/teams$/.test(r.url()),
  );
  await name.click();
  const res = await teams;
  expect(res.status()).toBe(200);
  // The new route carries teams and exposure only: no credentials or headers.
  expect(JSON.stringify(await res.json())).not.toMatch(/key|header|secret|token|password/i);

  const dialog = page.getByRole("dialog", { name: `Connector ${NAME}` });
  await expect(dialog).toBeVisible();
  const about = dialog.getByRole("region", { name: `About ${NAME}` });
  await expect(about.getByText("Server URL")).toBeVisible();
  await expect(about.getByText("Authentication")).toBeVisible();
  await expect(
    dialog
      .getByRole("region", { name: `Teams using ${NAME}` })
      .getByRole("listitem")
      .first(),
  ).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  const apps = dialog.getByRole("region", { name: `App templates of ${NAME}` });
  await expect(apps.getByRole("listitem").first()).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  expect(await apps.getByRole("listitem").count()).toBeGreaterThanOrEqual(3);

  const readOnly = dialog.getByRole("region", { name: `Read only tools of ${NAME}` });
  const write = dialog.getByRole("region", { name: `Write tools of ${NAME}` });
  await expect(readOnly).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await expect(write).toBeVisible();
  const first = dialog.getByRole("listitem", { name: / tool$/ }).first();
  await expect(first.getByText(/^(No inputs|Inputs:)/)).toBeVisible();
  await expect(first.getByText(/^(Open world|Closed world)$/)).toBeVisible();
  const titles = await badgeTitles(dialog);
  expect(titles.length).toBeGreaterThan(0);
  for (const t of titles) expect(t).toMatch(UI_TITLE);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(name).toBeFocused();
  // Escape closed only the detail panel, not the console under it.
  await expect(panelOf(page)).toBeVisible();
});
