import { expect, test, type Page } from "@playwright/test";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";
import { panelOf } from "./support/panel.js";

/**
 * KOBE-276: how shared cases counted in the agent's latest pre-publish eval, on its report.
 * Read-only. `KOBE_AGENT_ID` names a team agent whose evals `KOBE_USER` may read. Spends no
 * tokens. Run on gate1: `KOBE_AGENT_ID=… npx playwright test eval-cases-gate`.
 */
const AGENT_ID = process.env["KOBE_AGENT_ID"];
const TEAM_KEY = "kobe.lastTeamId";

/** The agent's latest eval id, read with the page's session (null when it has none). */
async function latestEval(page: Page, agentId: string): Promise<string | null> {
  return page.evaluate(
    async ({ id, teamKey }) => {
      const team = window.localStorage.getItem(teamKey);
      const res = await fetch(`/v1/agents/${encodeURIComponent(id)}/evals`, {
        headers: team ? { "x-kobe-team": team } : {},
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { evals: { id: string }[] };
      return body.evals[0]?.id ?? null;
    },
    { id: agentId, teamKey: TEAM_KEY },
  );
}

test("Eval report: how shared cases counted", async ({ page }) => {
  test.skip(!AGENT_ID, "set KOBE_AGENT_ID to a team agent KOBE_USER owns");
  await page.goto(`/admin/team/agents/${AGENT_ID}`);
  await expect(panelOf(page).getByRole("heading", { level: 1 })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  const evalId = await latestEval(page, AGENT_ID as string);
  test.skip(evalId === null, "the agent has no eval yet");
  await page.goto(`/admin/team/agents/${AGENT_ID}/evals/${evalId}`);
  const row = panelOf(page).locator("dt", { hasText: "Shared cases" });
  await expect(row).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await expect(row.locator("xpath=following-sibling::dd[1]")).toHaveText(
    /None in this evaluation\.|shared cases? (failed|in this evaluation)/,
  );
});
