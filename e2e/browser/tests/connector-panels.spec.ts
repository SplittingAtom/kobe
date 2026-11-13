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
const UI_NAME = /^MCP-UI: Opens an app: ui:\/\/\S+ \(/;
const TEAM_KEYS = ["enabled_tools", "exposure", "id", "name", "slug"];

/** The MCP-UI badges' accessible names (a focusable trigger each, KOBE-640). */
async function badgeNames(scope: Locator): Promise<string[]> {
  const badges = scope.locator("button[data-kobe-app-badge]");
  return badges.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));
}

/** The tools of one column: its own list, so other lists in the card never count. */
const toolItems = (column: Locator) =>
  column.getByRole("list", { name: /tools$/ }).getByRole("listitem");

/** The count in a column heading: "Write (4)" → 4. */
async function headingCount(heading: Locator): Promise<number> {
  return Number(/\((\d+)\)/.exec(await heading.innerText())?.[1] ?? Number.NaN);
}

const region = (scope: Locator, name: string) => scope.getByRole("region", { name, exact: true });

test("team Connectors: tools in Read only and Write columns, MCP-UI badges (KOBE-639, 640)", async ({
  page,
}) => {
  await page.goto("/admin/team/connectors");
  const card = panelOf(page).getByRole("article", { name: NAME, exact: true });
  await expect(card).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  const readOnly = region(card, `Read only tools of ${NAME}`);
  const write = region(card, `Write tools of ${NAME}`);
  const readHeading = readOnly.getByRole("heading", { name: /^Read only \(\d+\)$/ });
  const writeHeading = write.getByRole("heading", { name: /^Write \(\d+\)$/ });
  await expect(readHeading).toBeVisible();
  await expect(writeHeading).toBeVisible();
  // Each column lists exactly as many tools as its heading counts.
  expect(await toolItems(readOnly).count()).toBe(await headingCount(readHeading));
  expect(await toolItems(write).count()).toBe(await headingCount(writeHeading));
  // gate1's Catalyst has three ui:// templates, so at least one tool opens an app.
  const names = await badgeNames(card);
  expect(names.length).toBeGreaterThan(0);
  for (const n of names) expect(n).toMatch(UI_NAME);
  // The badge's tooltip opens on hover (its accessible name, checked above, carries the same text
  // for screen readers). On gate1 it did not open on keyboard focus: KOBE-654.
  await card.locator("button[data-kobe-app-badge]").first().hover();
  await expect(page.getByRole("tooltip").first()).toContainText("Opens an app: ui://");

  // Narrow: the columns stack, Write below Read only.
  await page.setViewportSize({ width: 600, height: 900 });
  await expect
    .poll(async () => {
      const a = await readOnly.boundingBox();
      const b = await write.boundingBox();
      return a !== null && b !== null && b.y >= a.y + a.height - 1;
    })
    .toBe(true);
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
  const body = (await res.json()) as { teams: Record<string, unknown>[] };
  expect(Object.keys(body)).toEqual(["teams"]);
  for (const t of body.teams) expect(Object.keys(t).toSorted()).toEqual(TEAM_KEYS);

  const dialog = page.getByRole("dialog", { name: `Connector ${NAME}`, exact: true });
  await expect(dialog).toBeVisible();
  const about = region(dialog, `About ${NAME}`);
  await expect(about.getByText("Server URL", { exact: true })).toBeVisible();
  await expect(about.getByText("Authentication", { exact: true })).toBeVisible();
  const teamList = region(dialog, `Teams using ${NAME}`).getByRole("list");
  await expect(teamList.getByRole("listitem").first()).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  const apps = region(dialog, `App templates of ${NAME}`).getByRole("list");
  await expect(apps.getByRole("listitem").first()).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  expect(await apps.getByRole("listitem").count()).toBeGreaterThanOrEqual(3);

  const readOnly = region(dialog, `Read only tools of ${NAME}`);
  const write = region(dialog, `Write tools of ${NAME}`);
  await expect(readOnly).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await expect(write).toBeVisible();
  const first = toolItems(readOnly).or(toolItems(write)).first();
  await expect(first.getByText(/^(No inputs|Inputs:)/)).toBeVisible();
  await expect(first.getByText(/^(Open world|Closed world)$/)).toBeVisible();
  const names = await badgeNames(dialog);
  expect(names.length).toBeGreaterThan(0);
  for (const n of names) expect(n).toMatch(UI_NAME);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(name).toBeFocused();
  // Escape closed only the detail panel, not the console under it.
  await expect(panelOf(page)).toBeVisible();
});
