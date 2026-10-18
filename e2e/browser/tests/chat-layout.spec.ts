import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./support/chat.js";

/**
 * KOBE-418: the chat without the bar's row two. The Agent, Model and Thinking selectors sit in the
 * composer's toolbar (folded into one "Agent and model" menu on a phone), Show details and Compact
 * now sit on the answers, the context gauge under the composer, and the conversation column is up
 * to 80rem wide. Light, dark and phone-width screenshots of the composer and an answer's action
 * bar, and full-window ones at 1440 and 1920 px, are attached to the report (the ledger's
 * evidence). Spends one short model turn.
 */
const PROMPT = "No tools. Reply with one short sentence about lighthouses.";
/** A turn with a tool step, so the answer has blocks to open (Show details shows only then). */
const TOOL_PROMPT = "Use the bash tool to run `echo kobe-418`, then reply with the single word OK.";
const COLUMN_MAX_PX = 1280;
/** At 1920 px the column is 80rem less its padding: far wider than the old 44rem (704 px). */
const COLUMN_MIN_AT_1920_PX = 1200;
const PHONE = { width: 390, height: 844 } as const;

/** Screenshots of `target` in both themes, attached to the report. */
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

/** The vertical centres of the visible controls in `toolbar`: one line when they all agree. */
async function centres(toolbar: Locator): Promise<number[]> {
  return toolbar.evaluate((el) =>
    [...el.querySelectorAll<HTMLElement>("button, select")]
      .filter((c) => c.closest("[hidden]") === null && c.getBoundingClientRect().width > 0)
      .map((c) => {
        const r = c.getBoundingClientRect();
        return Math.round(r.top + r.height / 2);
      }),
  );
}

async function expectOneLine(toolbar: Locator): Promise<void> {
  const ys = await centres(toolbar);
  expect(ys.length).toBeGreaterThan(1);
  expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(4);
}

/** Send (or Queue) lies wholly inside the composer panel: not clipped. */
async function expectSendInside(page: Page): Promise<void> {
  const panel = await page.locator("[data-kobe-composer-panel]").boundingBox();
  const send = await page
    .locator('[data-composer-toolbar] [data-command="send"]')
    .or(page.locator("[data-composer-toolbar]").getByRole("button", { name: "Queue" }))
    .first()
    .boundingBox();
  expect(panel).not.toBeNull();
  expect(send).not.toBeNull();
  if (!panel || !send) return;
  expect(send.x + send.width).toBeLessThanOrEqual(panel.x + panel.width);
}

async function noPageScrollX(page: Page): Promise<void> {
  const { scroll, width } = await page.evaluate(() => ({
    scroll: document.scrollingElement?.scrollWidth ?? 0,
    width: window.innerWidth,
  }));
  expect(scroll).toBeLessThanOrEqual(width);
}

test("one bar row; the composer holds the selectors and the gauge (ac-1, ac-2, ac-5)", async ({
  chat,
  page,
}) => {
  await chat.open();
  await expect(page.locator('[data-bar-row="2"]')).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Conversation context" })).toHaveCount(0);
  const toolbar = chat.toolbar;
  await expect(toolbar.getByRole("button", { name: "Attach files" })).toBeVisible();
  await expect(
    toolbar.getByRole("combobox", { name: "Model for this conversation" }),
  ).toBeVisible();
  await expectOneLine(toolbar);
  await expectSendInside(page);
  await shoot(page, "composer-new", page.locator("[data-kobe-composer]"));

  await chat.ask(PROMPT);
  // The gauge: under the composer, at the end of its row, once a model call counted the context.
  const meter = page.getByRole("meter", { name: "Context used" });
  await expect(meter).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("[data-composer-footer]").getByRole("meter")).toBeVisible();
  const footer = await page.locator("[data-composer-footer]").boundingBox();
  const gauge = await meter.boundingBox();
  if (footer && gauge) {
    expect(footer.x + footer.width - (gauge.x + gauge.width)).toBeLessThan(48);
  }
  await expectOneLine(toolbar);
  await shoot(page, "composer-started", page.locator("[data-kobe-composer]"));
});

test("an answer's action bar: Show details beside Fork, Compact now beside thumbs down (ac-3, ac-4)", async ({
  chat,
  page,
}) => {
  await chat.open();
  await chat.ask(TOOL_PROMPT);
  const answer = chat.answers.last();
  await answer.hover();
  const details = answer.getByRole("button", { name: "Show details", exact: true });
  await expect(details).toHaveAttribute("aria-pressed", /true|false/);
  const before = await details.getAttribute("aria-pressed");
  await details.click();
  await expect(details).not.toHaveAttribute("aria-pressed", before ?? "");
  await details.click();
  await expect(chat.compactNow).toBeVisible();
  await expect(chat.compactNow).toHaveAttribute("aria-disabled", "false");
  const bar = answer.locator("[data-kobe-answer-actions]");
  await shoot(page, "answer-actions", bar);
});

test("a phone: the selectors fold into one menu on one toolbar line (ac-2)", async ({
  chat,
  page,
}) => {
  await page.setViewportSize(PHONE);
  await chat.open();
  const toolbar = chat.toolbar;
  const menu = toolbar.getByRole("button", { name: "Agent and model", exact: true });
  await expect(menu).toBeVisible();
  const panel = page.getByRole("group", { name: "Agent and model", exact: true });
  // Closed until opened: really not shown (KOBE-418 review B1), not only `hidden` in the DOM.
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(`[id="${await menu.getAttribute("aria-controls")}"]`)).toBeHidden();
  await expectOneLine(toolbar);
  await expectSendInside(page);
  await noPageScrollX(page);
  await shoot(page, "composer-phone", page.locator("[data-kobe-composer]"));
  await menu.click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("combobox", { name: "Model for this conversation" })).toBeVisible();
  await shoot(page, "composer-phone-menu", page.locator("[data-kobe-composer]"));
  await panel.getByRole("combobox", { name: "Model for this conversation" }).focus();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toBeHidden();

  await chat.ask(PROMPT);
  await expect(chat.compactNow).toBeVisible();
  await shoot(page, "answer-actions-phone", chat.answers.last());
});

test("the conversation column is up to 80rem wide and centred, without page scroll (ac-8)", async ({
  chat,
  page,
}) => {
  await chat.open();
  await chat.ask(PROMPT);
  for (const width of [1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    const composer = await page.locator("[data-kobe-composer-column]").boundingBox();
    const main = await page.locator("#kobe-chat-main").boundingBox();
    expect(composer).not.toBeNull();
    expect(main).not.toBeNull();
    if (composer && main) {
      expect(composer.width).toBeLessThanOrEqual(COLUMN_MAX_PX + 1);
      if (width === 1920) expect(composer.width).toBeGreaterThan(COLUMN_MIN_AT_1920_PX);
      // Centred in the conversation's column.
      const left = composer.x - main.x;
      const right = main.x + main.width - (composer.x + composer.width);
      expect(Math.abs(left - right)).toBeLessThanOrEqual(2);
    }
    await noPageScrollX(page);
    await test.info().attach(`conversation-${width}.png`, {
      body: await page.screenshot({ animations: "disabled" }),
      contentType: "image/png",
    });
  }
});
