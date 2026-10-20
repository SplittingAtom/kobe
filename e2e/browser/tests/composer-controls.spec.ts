import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./support/chat.js";

/**
 * KOBE-450 ac-4. The Agent, Model and Thinking selectors sit in the composer's toolbar for a new
 * conversation and move to the line below it, before the right-aligned context gauge, once the
 * thread has its first prompt. Then a sample of the slash commands for Pi's built-ins: /session
 * (details and usage), /export (the server's Markdown download), /name (offers Kobe's /rename)
 * and /login (not offered: a disabled row with the reason, nothing sent). Light, dark and phone
 * screenshots of the composer are attached. Spends one short model turn.
 */
const PROMPT = "No tools. Reply with the single word ALPHA.";
const PHONE = { width: 390, height: 844 } as const;
const MODEL = { name: "Model for this conversation" } as const;

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

test("the selectors move below the composer after the first prompt; Pi's commands (ac-1, ac-3, ac-6)", async ({
  chat,
  page,
}) => {
  await chat.open();
  const below = page.locator('[data-composer-selectors="below"]');
  await expect(chat.toolbar.getByRole("combobox", MODEL)).toBeVisible();
  await expect(below).toHaveCount(0);

  await chat.ask(PROMPT);
  await chat.waitForIdle();
  await expect(below.getByRole("combobox", MODEL)).toBeVisible();
  await expect(chat.toolbar.getByRole("combobox", MODEL)).toHaveCount(0);
  await expect(chat.toolbar.getByRole("button", { name: "Add to your message" })).toBeVisible();
  const gauge = page.locator("[data-composer-footer] [data-composer-gauge]");
  const [s, g] = [await below.boundingBox(), await gauge.boundingBox()];
  if (s && g && g.width > 0) expect(s.x).toBeLessThan(g.x);
  await shoot(page, "composer-controls-below", page.locator("[data-kobe-composer]"));

  const actions = page.getByRole("listbox", { name: "Actions" });
  // /session: this conversation's details and usage.
  await chat.composer.pressSequentially("/session");
  await expect(actions.getByRole("option", { name: /^\/session, / })).toBeVisible();
  await chat.composer.press("Enter");
  const info = page.getByRole("dialog", { name: "This conversation" });
  await expect(info).toBeVisible();
  await expect(info).toContainText("Runs");
  await info.getByRole("button", { name: "Close", exact: true }).click();
  await expect(chat.composer).toHaveValue("");

  // /export: the server's Markdown download of this conversation.
  await chat.composer.pressSequentially("/export");
  await expect(actions.getByRole("option", { name: /^\/export, / })).toBeVisible();
  const [file] = await Promise.all([page.waitForEvent("download"), chat.composer.press("Enter")]);
  expect(file.suggestedFilename()).toMatch(/\.md$/);

  // /name: Kobe calls it /rename.
  await chat.composer.pressSequentially("/name");
  await expect(actions.getByRole("option")).toHaveCount(1);
  await expect(actions.getByRole("option", { name: /^\/rename, Rename/ })).toBeVisible();
  await chat.composer.press("Escape");
  await chat.composer.fill("");

  // /login: not offered; the row says why and Enter sends nothing.
  const before = await chat.userMessages.count();
  await chat.composer.pressSequentially("/login");
  const row = actions.getByRole("option");
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute("aria-disabled", "true");
  await expect(row).toContainText("/login isn't offered in Kobe");
  await chat.composer.press("Enter");
  await expect(chat.composer).toHaveValue("/login");
  expect(await chat.userMessages.count()).toBe(before);
  await chat.composer.fill("");
});

test("a phone: after the first prompt the selectors wrap below, nothing off the page (ac-1)", async ({
  chat,
  page,
}) => {
  await page.setViewportSize(PHONE);
  await chat.open();
  await chat.ask(PROMPT);
  await chat.waitForIdle();
  const below = page.locator('[data-composer-selectors="below"]');
  await expect(below.getByRole("combobox", MODEL)).toBeVisible();
  await expect(chat.toolbar.getByRole("button", { name: "Agent and model" })).toHaveCount(0);
  const { scroll, width } = await page.evaluate(() => ({
    scroll: document.scrollingElement?.scrollWidth ?? 0,
    width: window.innerWidth,
  }));
  expect(scroll).toBeLessThanOrEqual(width);
  const box = await below.boundingBox();
  if (box) expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
  await shoot(page, "composer-controls-phone", page.locator("[data-kobe-composer]"));
});

for (const width of [768, 1024] as const) {
  test(`at ${width} px: the selectors move below and the line fits the column (review LOW-7)`, async ({
    chat,
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await chat.open();
    await chat.ask(PROMPT);
    await chat.waitForIdle();
    const below = page.locator('[data-composer-selectors="below"]');
    await expect(below.getByRole("combobox", MODEL)).toBeVisible();
    await expect(chat.toolbar.getByRole("combobox", MODEL)).toHaveCount(0);
    const line = await page.locator("[data-composer-footer]").boundingBox();
    const panel = await page.locator("[data-kobe-composer-panel]").boundingBox();
    if (line && panel) expect(line.x + line.width).toBeLessThanOrEqual(panel.x + panel.width + 1);
    const scroll = await page.evaluate(() => document.scrollingElement?.scrollWidth ?? 0);
    expect(scroll).toBeLessThanOrEqual(width);
    await shoot(page, `composer-controls-${width}`, page.locator("[data-kobe-composer]"));
  });
}
