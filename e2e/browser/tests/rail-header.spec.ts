import type { Locator, Page } from "@playwright/test";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";
import { expect, FILES_TOGGLE, test, filesSection } from "./support/chat.js";

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
  // Its name carries the overall activity when there is any ("Threads panel, a conversation has
  // new activity"): another spec's thread may still be unread.
  await expect(line.getByRole("button", { name: /^Threads panel(, .+)?$/ })).toBeVisible();
  await expect(line.getByRole("button", { name: FILES_TOGGLE })).toBeVisible();
  await expect(line.getByRole("button", { name: "Collapse the rail" })).toBeVisible();
  // The selector (a menu with several teams, the name with one) is here, not in the bar.
  await expect(
    line.getByRole("navigation", { name: "Teams" }).or(line.getByRole("heading", { level: 2 })),
  ).toBeVisible();
  await expect(bar.getByRole("navigation", { name: "Teams" })).toHaveCount(0);
  // Team console is never in the bar any more; a team admin has it on the line.
  await expect(bar.getByRole("link", { name: "Team console" })).toHaveCount(0);
  // The gate1 owner is the team's admin: the link is on the line.
  await expect(line.getByRole("link", { name: "Team console" })).toHaveAttribute(
    "href",
    "/admin/team",
  );
  // One line: every control on it shares a centre. Only the ones on screen: with several teams
  // the selector's closed menu holds a button per team, laid out below the line but not shown
  // (KOBE-457).
  const ys = await line.evaluate((el) =>
    [...el.querySelectorAll<HTMLElement>("button, a, summary")]
      .filter((c) => c.checkVisibility())
      .map((c) => {
        const r = c.getBoundingClientRect();
        return Math.round(r.top + r.height / 2);
      }),
  );
  expect(ys.length).toBeGreaterThanOrEqual(4);
  expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(4);
  await shoot(page, "rail-header", page.locator('[data-shell-region="rail"]'));
  // KOBE-452: it opens the console as a panel over the workspace; Close returns focus to it.
  const teamConsole = line.getByRole("link", { name: "Team console" });
  await teamConsole.click();
  const panel = page.getByRole("dialog", { name: "Team console" });
  await expect(panel).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await panel.getByRole("button", { name: "Close Team console" }).click();
  await expect(panel).toHaveCount(0);
  await expect(teamConsole).toBeFocused();
});

test("Threads opens its panel; the Files toggle hides Files and is saved (KOBE-453)", async ({
  chat,
  page,
  context,
}) => {
  await chat.open();
  const line = chat.railHeader;
  const newThread = line.getByRole("button", { name: "New conversation", exact: true });
  const threadsButton = line.getByRole("button", { name: /^Threads panel/ });
  const filesToggle = line.getByRole("button", { name: FILES_TOGGLE });
  const files = filesSection(page);
  // New conversation sits immediately left of Threads.
  const newBox = await newThread.boundingBox();
  const threadsBox = await threadsButton.boundingBox();
  expect(newBox && threadsBox && threadsBox.x - (newBox.x + newBox.width)).toBeLessThan(12);
  await expect(page.getByRole("region", { name: "Threads" })).toHaveCount(0);
  try {
    await threadsButton.click();
    await expect(chat.threadsPanel).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/threads");
    await page.keyboard.press("Escape");
    await expect(chat.threadsPanel).toBeHidden();
    await expect(threadsButton).toBeFocused();

    // Hiding Files leaves the rail nothing to show: it collapses to its strip.
    await filesToggle.click();
    await expect(files).toBeHidden();
    await expect(page.locator('aside[aria-label="Workspace"]')).toHaveAttribute(
      "data-collapsed",
      "",
    );
    await expect.poll(() => storedPanels(page)).toBe("threads");
    await shoot(page, "rail-files-hidden", page.locator('[data-shell-region="rail"]'));

    // Another browser context of the same member (another device) gets the same choice.
    const browser = context.browser();
    if (!browser) throw new Error("no browser for a second context");
    const other = await browser.newContext({ storageState: await context.storageState() });
    const second = await other.newPage();
    await second.goto("/");
    await expect(second.locator('aside[aria-label="Workspace"]')).toHaveAttribute(
      "data-collapsed",
      "",
    );
    await expect(filesSection(second)).toBeHidden();
    await other.close();

    // Mod+Shift+F shows Files again, saved exactly like the toggle.
    await chat.composer.focus();
    await page.keyboard.press("ControlOrMeta+Shift+F");
    await expect(files).toBeVisible();
    await expect.poll(() => storedPanels(page)).toBe("both");

    // The collapsed rail keeps New conversation and Threads; Threads opens the panel.
    await chat.composer.press("ControlOrMeta+b");
    await page.getByRole("button", { name: /^Show threads/ }).click();
    await expect(chat.threadsPanel).toBeVisible();
    await chat.closeThreads();
    await chat.composer.press("ControlOrMeta+b");
  } finally {
    await chat.showBothPanels();
    await expect.poll(() => storedPanels(page)).toBe("both");
  }
});

test("a phone: the drawer is headed by the team selector (ac-2)", async ({ chat, page }) => {
  await page.setViewportSize(PHONE);
  await chat.open();
  // The bar stays one 56 px row with the team's name beside the drawer button (review S4).
  const row = page.locator('[data-bar-row="1"]');
  await expect(row.locator("[data-bar-team]")).toBeVisible();
  expect((await row.boundingBox())?.height ?? 0).toBeLessThanOrEqual(60);
  await page.setViewportSize({ width: 320, height: 640 });
  expect((await row.boundingBox())?.height ?? 0).toBeLessThanOrEqual(60);
  await page.setViewportSize(PHONE);
  await page.getByRole("button", { name: "Show the workspace" }).click();
  const drawer = page.getByRole("dialog", { name: "Workspace" });
  await expect(drawer).toBeVisible();
  const line = drawer.locator("[data-rail-header]");
  await expect(
    line.getByRole("navigation", { name: "Teams" }).or(line.getByRole("heading", { level: 2 })),
  ).toBeVisible();
  await expect(line.getByRole("button", { name: FILES_TOGGLE })).toBeVisible();
  await shoot(page, "rail-header-phone", drawer);
});

test("Files | Apps: one tabbed section, arrow keys, the last tab kept (KOBE-448)", async ({
  chat,
  page,
}) => {
  await chat.open();
  const tabs = page.getByRole("tablist", { name: "Files and apps" });
  if (!(await tabs.isVisible())) {
    // No apps and no key to add on this deployment: Files alone, without a tablist.
    await expect(filesSection(page)).toBeVisible();
    await expect(page.getByRole("tab", { name: "Apps" })).toHaveCount(0);
    return;
  }
  const files = tabs.getByRole("tab", { name: "Files", exact: true });
  const apps = tabs.getByRole("tab", { name: "Apps", exact: true });
  try {
    await expect(files).toHaveAttribute("aria-selected", "true");
    await files.focus();
    await page.keyboard.press("ArrowRight");
    await expect(apps).toBeFocused();
    await expect(apps).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel", { name: "Apps" })).toBeVisible();
    await expect(filesSection(page)).toBeHidden();
    await shoot(page, "rail-tabs-apps", page.locator('[data-shell-region="rail"]'));
    // Kept per member: a reload opens on Apps.
    await page.reload();
    await expect(apps).toHaveAttribute("aria-selected", "true", { timeout: SHELL_TIMEOUT_MS });
  } finally {
    await chat.showBothPanels();
    await expect(files).toHaveAttribute("aria-selected", "true");
  }
});
