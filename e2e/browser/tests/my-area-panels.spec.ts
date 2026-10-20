import type { Locator, Page } from "@playwright/test";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";
import { expect, test } from "./support/chat.js";

/**
 * KOBE-424 (CE4, U18), as panels since KOBE-452 (ac-6): My memory, My approvals, My schedules and
 * My connectors open as the same large overlay as the consoles, over the thread, at their own
 * addresses (`/me/memory`, ...); on a phone a full-screen sheet. Light, dark and phone screenshots
 * are attached to the report, and the checks make sure each page's content loaded (no error
 * notice), that Close returns to the same thread, that the browser's Back after a Close never
 * reopens it, and that the console portal (confirm dialogs, row menus) sits outside the chat.
 * Runs against gate1 like the rest of the suite (README.md).
 */
const PAGES = [
  { path: "/me/memory", name: "My memory", open: { bar: "my-memory" } },
  { path: "/me/schedules", name: "My schedules", open: { bar: "my-schedules" } },
  { path: "/me/approvals", name: "My approvals", open: { menu: "My approvals" } },
  { path: "/me/connectors", name: "My connectors", open: { menu: "My connectors" } },
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
  // On a phone the bar's links sit in its Menu.
  const menu = page.locator('[data-command="thread-menu"]');
  if (await menu.isVisible()) await menu.click();
  if ("bar" in opener) {
    await page.locator(`[data-command="${opener.bar}"]`).click();
    return;
  }
  await page.locator('[data-command="profile"]').click();
  await page.getByRole("link", { name: opener.menu }).click();
}

const panels = (page: Page) => page.locator("[data-kobe-panel]");
const slug = (path: string) => path.split("/").pop() ?? path;

test.describe("My area pages as panels over the workspace (KOBE-424, KOBE-452)", () => {
  for (const { path, name, open } of PAGES) {
    test(`${name} opens over the thread, and Close returns to it`, async ({ chat, page }) => {
      await chat.open();
      await chat.ask("No tools. Reply with the single word PANEL.");
      const thread = await chat.threadId();
      await openFrom(page, open);
      const panel = page.getByRole("dialog", { name });
      await expect(panel).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
      // The page loaded (access read, no error notice).
      await expect(panel.locator("[data-kobe-console]").first()).toBeVisible({
        timeout: SHELL_TIMEOUT_MS,
      });
      await expect(panel.getByText(/^(Loading|Checking your access)…$/)).toHaveCount(0, {
        timeout: SHELL_TIMEOUT_MS,
      });
      await expect(panel.getByRole("alert")).toHaveCount(0);
      expect(new URL(page.url()).pathname).toBe(path);
      // The workspace stays mounted underneath, out of reach while the panel is open.
      await expect(page.locator("[data-kobe-chat] main#kobe-chat-main")).toHaveCount(1);
      await expect(chat.composer).toBeHidden();
      await shoot(page, `panel-${slug(path)}-1280`, page.locator("body"));

      await panel.getByRole("button", { name: `Close ${name}` }).click();
      await expect(panels(page)).toHaveCount(0);
      expect(new URL(page.url()).searchParams.get("thread")).toBe(thread);
      await expect(chat.composer).toBeVisible();
      await expect(chat.answers.last()).toContainText("PANEL");
      // Back after Close goes on to earlier pages; it never reopens the closed one.
      await page.goBack();
      await expect(panels(page)).toHaveCount(0);
    });
  }

  test("at 800 px it is a full-screen sheet", async ({ chat, page }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await chat.open();
    await openFrom(page, PAGES[0].open);
    const panel = page.getByRole("dialog", { name: "My memory" });
    await expect(panel).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    const box = await panel.boundingBox();
    expect(box?.width).toBe(800);
    await shoot(page, "panel-memory-800", page.locator("body"));
    await page.keyboard.press("Escape");
    await expect(panels(page)).toHaveCount(0);
    await expect(chat.composer).toBeVisible();
  });

  test("on a phone each is a full-screen sheet, and the system Back doesn't reopen it", async ({
    chat,
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chat.open();
    for (const { path, name, open } of PAGES) {
      await openFrom(page, open);
      const sheet = page.getByRole("dialog", { name });
      await expect(sheet).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
      await shoot(page, `panel-${slug(path)}-390`, sheet);
      await sheet.getByRole("button", { name: `Close ${name}` }).click();
      await expect(panels(page)).toHaveCount(0);
      await expect(chat.composer).toBeVisible();
    }
    await page.goBack();
    await expect(panels(page)).toHaveCount(0);
  });

  test("the pages' dialogs and menus mount at the document's top, outside the chat", async ({
    chat,
    page,
  }) => {
    await chat.open();
    await openFrom(page, PAGES[0].open);
    await expect(page.getByRole("dialog", { name: "My memory" })).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });
    const portal = page.locator("body > [data-kobe-console-portal]");
    await expect(portal).toHaveCount(1);
    expect(await portal.evaluate((el) => el.closest("[data-kobe-chat]") === null)).toBe(true);
  });

  test("an address from before (?area=memory) opens the panel over its thread", async ({
    chat,
    page,
  }) => {
    await chat.open();
    await chat.ask("No tools. Reply with the single word AREA.");
    const thread = await chat.threadId();
    await page.goto(`/?thread=${thread}&area=memory`);
    await expect(page.getByRole("dialog", { name: "My memory" })).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });
    expect(new URL(page.url()).pathname).toBe("/me/memory");
    await page.keyboard.press("Escape");
    await expect(panels(page)).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("thread")).toBe(thread);
  });
});
