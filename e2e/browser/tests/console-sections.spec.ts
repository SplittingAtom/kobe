import { expect, test, type Page } from "@playwright/test";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";

/**
 * The console sections that were "coming soon" although their tickets were done (KOBE-291): the
 * Site audit log, Site backup and restore, and the Team inventory. Read-only: it applies a filter
 * and clears it, nothing else. `KOBE_USER` must be the site Owner (or an Admin) and a team admin
 * of the active team. Spends no tokens. Run on gate1: `npx playwright test console-sections`.
 */

async function open(page: Page, path: string, title: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await expect(page.getByText(/coming in KOBE-/i)).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: /^Loading/ })).toHaveCount(0, {
    timeout: SHELL_TIMEOUT_MS,
  });
}

test("Site audit log: events, filters and the chain status", async ({ page }) => {
  await open(page, "/admin/site/audit", "Audit log");
  const chain = page.getByRole("region", { name: "Chain integrity" });
  // Never checked on open: only Verify chain runs it (the server allows 3 a minute).
  await expect(chain.getByText("Not verified yet.")).toBeVisible();
  await chain.getByRole("button", { name: "Verify chain" }).click();
  await expect(
    chain.getByText(/Chain verified|The chain is broken|^Try again in a minute/).first(),
  ).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await expect(chain.getByText("The chain is broken")).toHaveCount(0);

  const events = page.getByRole("table", { name: "Audit events, newest first" });
  await expect(events).toBeVisible();
  await page.getByLabel("Category").selectOption("auth");
  const filtered = page.waitForResponse(
    (r) => r.url().includes("/v1/site/audit?") && r.url().includes("category=auth"),
  );
  await page.getByRole("button", { name: "Apply filters" }).click();
  expect((await filtered).status()).toBe(200);
  await expect(events.or(page.getByText("No events match these filters.").first())).toBeVisible();
  // The server filtered: every action shown is in the auth category.
  await expect(async () => {
    const actions = await events.locator("tbody td code").allTextContents();
    expect(actions.filter((a) => !a.startsWith("auth."))).toEqual([]);
  }).toPass();
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(events).toBeVisible();
});

test("Site backup and restore: status and steps", async ({ page }) => {
  await open(page, "/admin/site/backup", "Backup and restore");
  await expect(
    page.getByRole("note").filter({ hasText: "Kobe can't see your backups" }),
  ).toBeVisible();
  await expect(
    page.getByText(/No restore has been recorded on this site\.|Restored/).first(),
  ).toBeVisible();
  await expect(page.getByText(/^(Running|Paused)$/)).toBeVisible();
  await expect(page.getByLabel("Take a backup")).toContainText("kobe backup --out");
  await expect(page.getByLabel("Restore a backup")).toContainText("kobe restore --from");
});

test("Team inventory: agents, skills and connectors", async ({ page }) => {
  await open(page, "/admin/team/inventory", "Inventory");
  for (const name of ["Agents", "Skills", "Connectors"]) {
    await expect(page.getByRole("region", { name })).toBeVisible();
  }
  const agents = page.getByRole("region", { name: "Agents" });
  await expect(
    agents.getByRole("table", { name: "Agent inventory" }).or(agents.getByText("No agents yet.")),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
