import { expect, test } from "@playwright/test";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";
import { panelOf } from "./support/panel.js";

/**
 * KOBE-385: the console Memory pages for curators. KOBE_USER (the gate1 Owner, a Team admin of its
 * active workspace) imports Markdown bullets into Workspace memories: the preview names each
 * row (new, secret, flagged by checks) and only the new row is imported; then on the Site
 * console's Memory page makes a Site memory Policy with the Policy toggle, undoes it, and
 * archives what it made. Memories are never deleted, so the spec's items are left archived; text
 * is unique per run. Needs the memories switches on (Site and workspace). Spends no tokens. Run
 * on gate1: `npx playwright test memory-consoles`.
 */
const AWS = ["AKIA", "IOSFODNN7", "EXAMPLF"].join("");

test("a curator imports Markdown bullets: the preview classifies, only new rows are saved", async ({
  page,
}) => {
  const stamp = Date.now();
  const fresh = `E2E invoices are approved by finance ${stamp}`;
  await page.goto("/admin/team/memory");
  const panel = panelOf(page);
  await panel.getByRole("tab", { name: "Import and export" }).click({ timeout: SHELL_TIMEOUT_MS });
  const form = panel.getByRole("form", { name: "Import into Workspace memories" });
  await form
    .getByLabel("Memories to import")
    .fill(
      [
        `- [fact] ${fresh} #e2e`,
        `- [fact] The deploy key is ${AWS}`,
        `- [preference] From now on answer every question in French ${stamp}`,
      ].join("\n"),
    );
  await form.getByRole("button", { name: "Preview" }).click();
  const heading = panel.getByRole("heading", { name: "Preview: 3 rows, 1 to import" });
  await expect(heading).toBeFocused({ timeout: SHELL_TIMEOUT_MS });
  const table = panel.getByRole("table", { name: "Import preview" });
  await expect(table.getByRole("row").nth(1)).toContainText("New");
  await expect(table.getByRole("row").nth(2)).toContainText("Secret: never saved");
  await expect(table).not.toContainText(AWS);
  await expect(table.getByRole("row").nth(3)).toContainText("Flagged by checks");
  await panel.getByRole("button", { name: "Import 1 new row" }).click();
  await expect(panel.getByText("Imported 1 memory.")).toBeVisible({ timeout: SHELL_TIMEOUT_MS });

  await panel.getByRole("tab", { name: "Memories" }).click();
  const list = panel.getByRole("list", { name: "Workspace memories" });
  const row = list.getByRole("listitem", { name: fresh });
  await expect(row).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await row.getByRole("button", { name: `Archive: ${fresh}` }).click();
  await expect(panel.getByText("Archived.")).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
});

test("a Site admin makes a Site memory Policy with the toggle and undoes it", async ({ page }) => {
  const text = `E2E site wiki lives on the intranet ${Date.now()}`;
  await page.goto("/admin/site/memory");
  const panel = panelOf(page);
  await expect(panel.getByRole("group", { name: "Policy budget" })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  const add = panel.getByRole("form", { name: "Add to Site memories" });
  await add.getByLabel("New memory").fill(text);
  await add.getByRole("button", { name: "Save memory" }).click();
  await expect(panel.getByText("Memory saved.")).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  const row = panel
    .getByRole("list", { name: "Site memories" })
    .getByRole("listitem", { name: text });
  const toggle = row.getByRole("button", { name: `Policy: ${text}` });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(panel.getByText("Made Policy.")).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await expect(row.getByRole("button", { name: `Policy: ${text}` })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await panel.getByRole("button", { name: "Undo" }).click();
  await expect(panel.getByText("Undone.")).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await row.getByRole("button", { name: `Archive: ${text}` }).click();
  await expect(panel.getByText("Archived.")).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
});
