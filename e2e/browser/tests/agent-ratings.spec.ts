import { expect, test } from "@playwright/test";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";
import { panelOf } from "./support/panel.js";

/**
 * KOBE-275 ac-3: the agent's Ratings section on its page in the Team console. Read-only: it
 * switches the period and checks what the server allowed it to show. `KOBE_AGENT_ID` names a team
 * agent whose builder-owner `KOBE_USER` is (or a team agent of a team `KOBE_USER` administers).
 * Spends no tokens. Run on gate1: `KOBE_AGENT_ID=… npx playwright test agent-ratings`.
 */
const AGENT_ID = process.env["KOBE_AGENT_ID"];

test("Ratings: fixed periods, counts only, withheld numbers say so", async ({ page }) => {
  test.skip(!AGENT_ID, "set KOBE_AGENT_ID to a team agent KOBE_USER owns");
  const first = page.waitForResponse((r) => r.url().includes(`/feedback?window=30`));
  await page.goto(`/admin/team/agents/${AGENT_ID}`);
  expect((await first).status()).toBe(200);
  const ratings = panelOf(page).getByRole("region", { name: "Ratings" });
  await expect(ratings).toBeVisible({ timeout: SHELL_TIMEOUT_MS });

  const period = ratings.getByLabel("Period");
  await expect(period.locator("option")).toHaveText([
    "Last 7 days",
    "Last 30 days",
    "Last 90 days",
  ]);
  const week = page.waitForResponse((r) => r.url().includes(`/feedback?window=7`));
  await period.selectOption("7");
  expect((await week).status()).toBe(200);

  // Either too few raters (no numbers at all), or totals with each breakdown shown or withheld.
  // Exact: the section's description also says "thumbs up and down".
  await expect(
    ratings
      .getByText(/^Not enough ratings yet/)
      .or(ratings.getByText("Thumbs up", { exact: true }).first()),
  ).toBeVisible();
  // Counts only: nothing in the section links to a member or a conversation.
  await expect(ratings.getByRole("link")).toHaveCount(0);
});
