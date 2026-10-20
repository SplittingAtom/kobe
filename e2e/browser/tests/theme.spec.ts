import type { Page } from "@playwright/test";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";
import { type Chat, expect, test } from "./support/chat.js";
import { expectThemed, MIN_CONTRAST, type Paint, paintOf, type Theme } from "./support/colours.js";
import { panelOf } from "./support/panel.js";

const THEME_COOKIE = "kobe-theme";

const themeToggle = (page: Page) =>
  page.getByRole("button", { name: "Dark theme", exact: true }).first();

/**
 * Opens each chat popup, checks it paints in `theme` and closes it. Returns the tooltip's paint:
 * tooltips are inverted on purpose, so they are compared across themes instead.
 */
async function checkPopups(chat: Chat, page: Page, theme: Theme): Promise<Paint> {
  // Regenerate with… (a menu portalled into the chat root).
  await (await chat.messageAction(chat.answers.last(), "Regenerate with…")).click();
  const menu = page.getByRole("menu", { name: "Regenerate with…" });
  await expect(menu).toBeVisible();
  expectThemed("Regenerate with… menu", await paintOf(menu), theme);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  // Compact (the latest answer's Compact now, KOBE-418) and its input.
  await chat.compactNow.click();
  const compact = page.getByRole("dialog", { name: "Compact this thread" });
  await expect(compact).toBeVisible();
  expectThemed("Compact dialog", await paintOf(compact), theme);
  expectThemed("Compact dialog input", await paintOf(compact.getByRole("textbox")), theme);
  await page.keyboard.press("Escape");
  await expect(compact).toBeHidden();

  // Fork (from the answer's actions).
  await (await chat.messageAction(chat.answers.last(), "Fork to a new thread")).click();
  const fork = page.getByRole("dialog", { name: "Fork to a new thread" });
  await expect(fork).toBeVisible();
  expectThemed("Fork dialog", await paintOf(fork), theme);
  await page.keyboard.press("Escape");
  await expect(fork).toBeHidden();

  // Notifications (the bar's bell opens a panel; the bell closes it).
  const bell = page.getByRole("button", { name: /^Notifications/ }).first();
  await bell.click();
  const notes = page.getByRole("region", { name: "Notifications" });
  await expect(notes).toBeVisible();
  expectThemed("Notifications panel", await paintOf(notes), theme);
  await bell.click();
  await expect(notes).toBeHidden();

  // A tooltip (the toggle's own).
  await page.mouse.move(0, 400);
  await themeToggle(page).hover();
  const tooltip = page.locator('[data-slot="tooltip-content"]').first();
  await expect(tooltip).toBeVisible();
  const paint = await paintOf(tooltip);
  expect(
    Math.abs(paint.backgroundLuminance - paint.textLuminance),
    `tooltip in ${theme}`,
  ).toBeGreaterThan(MIN_CONTRAST);
  await page.mouse.move(0, 400);
  return paint;
}

async function expectTheme(page: Page, theme: Theme): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(themeToggle(page)).toHaveAttribute("aria-pressed", String(theme === "dark"));
}

test("theme toggle: popups in light and dark, the choice survives a reload, admin header toggle", async ({
  chat,
  page,
  context,
}) => {
  // The OS says light (config) and nothing is saved yet.
  await context.clearCookies({ name: THEME_COOKIE });
  await chat.open();
  await expect(themeToggle(page)).toHaveAttribute("aria-pressed", "false");
  await chat.ask("No tools. Reply with the single word OK.");

  const lightTooltip = await checkPopups(chat, page, "light");

  await themeToggle(page).click();
  await expectTheme(page, "dark");
  const cookie = (await context.cookies()).find((c) => c.name === THEME_COOKIE);
  expect(cookie?.value).toBe("dark");

  const darkTooltip = await checkPopups(chat, page, "dark");
  expect(darkTooltip.background).not.toBe(lightTooltip.background);

  // The cookie gives the server the theme: the first paint is already dark.
  const reloaded = await page.reload();
  expect(await reloaded?.text()).toMatch(/<html[^>]*data-theme="dark"/);
  await expect(chat.composer).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await expectTheme(page, "dark");

  // The admin console has the same toggle and the same saved choice.
  // Since KOBE-452 the console is a panel over the workspace, its toggle in the panel's header line.
  await page.goto("/admin/team/connectors");
  await expectTheme(page, "dark");
  await panelOf(page).getByRole("button", { name: "Dark theme", exact: true }).click();
  await expectTheme(page, "light");
  expect((await context.cookies()).find((c) => c.name === THEME_COOKIE)?.value).toBe("light");
});
