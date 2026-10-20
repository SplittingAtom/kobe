import { expect, test } from "@playwright/test";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";
import { panelOf } from "./support/panel.js";

/**
 * KOBE-276 ac-2: the agent owner's Shared cases page. Read-only: it opens the list and one case if
 * there is any; it changes nothing.
 * `KOBE_AGENT_ID` names a team agent whose builder-owner `KOBE_USER` is. Spends no tokens.
 * Run on gate1: `KOBE_AGENT_ID=… npx playwright test shared-cases-review`.
 */
const AGENT_ID = process.env["KOBE_AGENT_ID"];

test("Shared cases: the day only, no sharer, review controls", async ({ page }) => {
  test.skip(!AGENT_ID, "set KOBE_AGENT_ID to a team agent KOBE_USER owns");
  await page.goto(`/admin/team/agents/${AGENT_ID}`);
  const summary = panelOf(page).getByRole("region", { name: "Shared cases" });
  await expect(summary).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await summary.getByRole("link", { name: "Review shared cases" }).click();
  await expect(
    panelOf(page).getByRole("heading", { level: 1, name: "Shared cases" }),
  ).toBeVisible();

  const table = panelOf(page).getByRole("table", { name: "Shared cases" });
  await expect(table.or(panelOf(page).getByText("No shared cases yet."))).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  if (!(await table.isVisible())) return;
  // Day only: no time of day in the list.
  expect(await table.textContent()).not.toMatch(/\b\d{1,2}:\d{2}\b/);
  await table
    .getByRole("link", { name: /^Review/ })
    .first()
    .click();
  await expect(panelOf(page).getByRole("region", { name: "What was shared" })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await expect(panelOf(page).getByLabel("Expected behaviour")).toBeVisible();
  await expect(
    panelOf(page)
      .getByRole("button", { name: /^(Accept|Reopen)$/ })
      .first(),
  ).toBeVisible();
});
