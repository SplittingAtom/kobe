import type { Locator, Page } from "@playwright/test";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";
import { expect, test } from "./support/chat.js";

/**
 * KOBE-424 (CE4, U18): My memory, My approvals, My schedules and My connectors open beside the
 * thread, with the conversation and its composer on screen; on a phone a full-screen sheet with
 * Back. Light, dark and phone screenshots are attached to the report (ac-3), and the checks make
 * sure each page's content loaded (no error notice), that the browser's Back after a Close never
 * reopens it, and that the console portal (confirm dialogs, row menus) sits outside the chat. Runs against gate1 like the rest of the suite (README.md).
 */
const PAGES = [
  { area: "memory", name: "My memory", open: { bar: "my-memory" } },
  { area: "schedules", name: "My schedules", open: { bar: "my-schedules" } },
  { area: "approvals", name: "My approvals", open: { menu: "My approvals" } },
  { area: "connectors", name: "My connectors", open: { menu: "My connectors" } },
] as const;

type Opener = (typeof PAGES)[number]["open"];

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

async function openFrom(page: Page, opener: Opener): Promise<void> {
  if ("bar" in opener) {
    // On a phone the bar's links sit in its Menu.
    const menu = page.locator('[data-command="thread-menu"]');
    if (await menu.isVisible()) await menu.click();
    await page.locator(`[data-command="${opener.bar}"]`).click();
    return;
  }
  const menu = page.locator('[data-command="thread-menu"]');
  if (await menu.isVisible()) await menu.click();
  await page.locator('[data-command="profile"]').click();
  await page.getByRole("link", { name: opener.menu }).click();
}

/** The page beside the thread: a region on wide screens, a dialog (the sheet) on a phone. */
const panelOf = (page: Page, name: string) =>
  page.locator("[data-kobe-area]").filter({ has: page.getByRole("heading", { name }) });

test.describe("My area pages beside the thread (KOBE-424)", () => {
  for (const { area, name, open } of PAGES) {
    test(`${name} opens beside the thread with the composer on screen`, async ({ chat, page }) => {
      await chat.open();
      await chat.ask("No tools. Reply with the single word BESIDE.");
      const thread = await chat.threadId();
      await openFrom(page, open);
      const panel = panelOf(page, name);
      await expect(panel).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
      // The page loaded (access read, no error notice).
      await expect(panel.locator("[data-kobe-console]")).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
      await expect(panel.getByText("Loading…", { exact: true })).toHaveCount(0, {
        timeout: SHELL_TIMEOUT_MS,
      });
      await expect(panel.getByRole("alert")).toHaveCount(0);
      await expect(chat.composer).toBeInViewport();
      await expect(chat.answers.last()).toBeInViewport();
      const url = new URL(page.url());
      expect(url.pathname).toBe("/");
      expect(url.searchParams.get("thread")).toBe(thread);
      expect(url.searchParams.get("area")).toBe(area);
      await shoot(page, `beside-${area}-1280`, page.locator("[data-kobe-chat]"));

      await panel.getByRole("button", { name: `Close ${name}` }).click();
      await expect(page.locator("[data-kobe-area]")).toHaveCount(0);
      // Back after Close goes on to earlier pages; it never reopens the closed one.
      await page.goBack();
      await expect(page.locator("[data-kobe-area]")).toHaveCount(0);
    });
  }

  test("at 800 px it is a sheet over the conversation", async ({ chat, page }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await chat.open();
    await openFrom(page, PAGES[0].open);
    const panel = panelOf(page, "My memory");
    await expect(panel).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(chat.composer).toBeVisible();
    await shoot(page, "beside-memory-800", page.locator("[data-kobe-chat]"));
    await panel.getByRole("button", { name: "Back to the conversation" }).click();
    await expect(page.locator("[data-kobe-area]")).toHaveCount(0);
  });

  test("on a phone it is a full-screen sheet with Back, and the system Back doesn't reopen it", async ({
    chat,
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chat.open();
    for (const { area, name, open } of PAGES) {
      await openFrom(page, open);
      const sheet = page.getByRole("dialog", { name });
      await expect(sheet).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
      await shoot(page, `beside-${area}-390`, sheet);
      await sheet.getByRole("button", { name: "Back to the conversation" }).click();
      await expect(page.locator("[data-kobe-area]")).toHaveCount(0);
      await expect(chat.composer).toBeVisible();
    }
    await page.goBack();
    await expect(page.locator("[data-kobe-area]")).toHaveCount(0);
  });

  test("the pages' dialogs and menus mount at the document's top, outside the chat's column", async ({
    chat,
    page,
  }) => {
    await chat.open();
    await openFrom(page, PAGES[0].open);
    const panel = panelOf(page, "My memory");
    await expect(panel).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    // Console dialogs mount at the document's top (KOBE-424), outside the chat and its column.
    const portal = page.locator("body > [data-kobe-console-portal]");
    await expect(portal).toHaveCount(1);
    expect(await portal.evaluate((el) => el.closest("[data-kobe-chat]") === null)).toBe(true);
    await shoot(page, "beside-memory-portal-1280", page.locator("body"));
  });
});
