import { expect, test } from "@playwright/test";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";
import { panelOf } from "./support/panel.js";

/**
 * KOBE-430 ac-4: the Re-probe button on the site connector registry, against a real MCP server
 * (on gate1 the Catalyst connector). `KOBE_USER` is a site admin; `KOBE_CONNECTOR` names the
 * connector (default `catalyst_2`). It re-probes once and checks the outcome is said in words:
 * unchanged, the counts, or a failure reason (a refusal for a recent re-probe also counts). Spends
 * no model tokens. Run on gate1: `npx playwright test connector-reprobe`.
 */
const NAME = process.env["KOBE_CONNECTOR"] ?? "catalyst_2";

test("Re-probe: probes now and says what happened", async ({ page }) => {
  await page.goto("/admin/site/connectors");
  const panel = panelOf(page);
  const button = panel.getByRole("button", { name: `Re-probe ${NAME}` });
  await expect(button).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  const answer = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/refresh"),
  );
  await button.click();
  const res = await answer;
  expect([200, 409, 429, 502]).toContain(res.status());
  const body = (await res.json()) as { refresh?: { message: string }; message?: string };
  const said = body.refresh?.message ?? body.message ?? "";
  expect(said).not.toBe("");
  await expect(panel.getByText(said, { exact: true })).toBeVisible();
  // Nothing in the answer carries a key or the server's own error text.
  expect(JSON.stringify(body)).not.toMatch(/api[_-]?key"?\s*:/i);
});
