import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./support/chat.js";

/**
 * KOBE-419: the rail's top line. The team selector (moved from the bar), the Threads and Files
 * panel toggles (saved per member; the last one on stays on), Team console for team admins (moved
 * from the bar), then collapse. Light, dark and phone screenshots are attached to the report (the
 * ledger's evidence). Spends no model turn; leaves both panels on.
 */
const PHONE = { width: 390, height: 844 } as const;

async function shoot(page: Page, name: string, target: Locator): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await test.info().attach(`${name}-${theme}.png`, {
      body: await target.screenshot({ animations: "disabled" }),
      contentType: "image/png",
    });
  }
  await page.evaluate(() => delete document.documentElement.dataset.theme);
}

/** The stored panels choice (`GET /v1/me/preferences`), "both" when absent. */
async function storedPanels(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const res = await fetch("/v1/me/preferences");
    const body = (await res.json()) as { preferences: { rail_panels?: string } };
    return body.preferences.rail_panels ?? "both";
  });
}

test("the top line: team, Threads, Files, Team console (admins), collapse (ac-1, ac-2, ac-5)", async ({
  chat,
  page,
}) => {
  await chat.open();
  const line = chat.railHeader;
  const bar = page.locator('[data-bar-row="1"]');
  await expect(line.getByRole("button", { name: "Threads panel", exact: true })).toBeVisible();
  await expect(line.getByRole("button", { name: "Files panel", exact: true })).toBeVisible();
  await expect(line.getByRole("button", { name: "Collapse the rail" })).toBeVisible();
  // The selector (a menu with several teams, the name with one) is here, not in the bar.
  await expect(
    line.getByRole("navigation", { name: "Teams" }).or(line.getByRole("heading", { level: 2 })),
  ).toBeVisible();
  await expect(bar.getByRole("navigation", { name: "Teams" })).toHaveCount(0);
  // Team console is never in the bar any more; a team admin has it on the line.
  await expect(bar.getByRole("link", { name: "Team console" })).toHaveCount(0);
  const consoleLink = line.getByRole("link", { name: "Team console" });
  if ((await consoleLink.count()) > 0) {
    await expect(consoleLink).toHaveAttribute("href", "/admin/team");
  }
  // One line: every control on it shares a centre.
  const ys = await line.evaluate((el) =>
    [...el.querySelectorAll<HTMLElement>("button, a, summary")].map((c) => {
      const r = c.getBoundingClientRect();
      return Math.round(r.top + r.height / 2);
    }),
  );
  expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(4);
  await shoot(page, "rail-header", page.locator('[data-shell-region="rail"]'));
});

test("panel toggles: one panel fills the rail, the last stays on, the choice is saved (ac-3, ac-4)", async ({
  chat,
  page,
  context,
}) => {
  await chat.open();
  const line = chat.railHeader;
  const threadsToggle = line.getByRole("button", { name: "Threads panel", exact: true });
  const filesToggle = line.getByRole("button", { name: "Files panel", exact: true });
  const threads = page.getByRole("region", { name: "Threads" });
  const files = page.getByRole("region", { name: "Files" });
  const divider = page.getByRole("separator", { name: "Resize Threads and Files" });
  try {
    await threadsToggle.click();
    await expect(threadsToggle).toHaveAttribute("aria-pressed", "false");
    await expect(threads).toBeHidden();
    await expect(divider).toHaveCount(0);
    await expect(files).toBeVisible();
    await expect(filesToggle).toHaveAttribute("aria-disabled", "true");
    await filesToggle.click();
    await expect(files).toBeVisible();
    await expect.poll(() => storedPanels(page)).toBe("files");
    await shoot(page, "rail-files-only", page.locator('[data-shell-region="rail"]'));

    // Another browser context of the same member (another device) gets the same panels.
    const other = await context.browser()?.newContext({
      storageState: await context.storageState(),
    });
    if (other) {
      const second = await other.newPage();
      await second.goto("/");
      await expect(second.getByRole("region", { name: "Files" })).toBeVisible();
      await expect(second.getByRole("region", { name: "Threads" })).toBeHidden();
      await other.close();
    }

    // Show threads from the keyboard path: the collapsed rail's icon turns it back on.
    await chat.composer.press("ControlOrMeta+b");
    await page.getByRole("button", { name: "Show threads" }).click();
    await expect(threads).toBeVisible();
  } finally {
    await chat.showBothPanels();
    await expect.poll(() => storedPanels(page)).toBe("both");
  }
  await expect(divider).toBeVisible();
});

test("a phone: the drawer is headed by the team selector (ac-2)", async ({ chat, page }) => {
  await page.setViewportSize(PHONE);
  await chat.open();
  await page.getByRole("button", { name: "Show the workspace" }).click();
  const drawer = page.getByRole("dialog", { name: "Workspace" });
  await expect(drawer).toBeVisible();
  const line = drawer.locator("[data-rail-header]");
  await expect(
    line.getByRole("navigation", { name: "Teams" }).or(line.getByRole("heading", { level: 2 })),
  ).toBeVisible();
  await expect(line.getByRole("button", { name: "Files panel", exact: true })).toBeVisible();
  await shoot(page, "rail-header-phone", drawer);
});
