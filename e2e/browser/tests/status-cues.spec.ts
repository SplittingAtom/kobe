import type { Locator, Page } from "@playwright/test";
import { RUN_START_TIMEOUT_MS } from "./support/constants.js";
import { expect, test } from "./support/chat.js";

/** Streams long enough for every check below to happen while the run goes. */
const STORY =
  "No tools. Write a detailed 1500-word short story about a lighthouse keeper and a storm.";

/** The element's text colour as [r, g, b] (any CSS colour syntax, through a canvas). */
function rgbOf(el: Locator): Promise<number[]> {
  return el.evaluate((node) => {
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (ctx === null) throw new Error("no 2d canvas");
    ctx.fillStyle = getComputedStyle(node).color;
    ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
  });
}

const greenish = ([r = 0, g = 0, b = 0]: number[]) => g > r && g > b;
const reddish = ([r = 0, g = 0, b = 0]: number[]) => r > g && r > b;

/** Screenshots of a cue in both themes, attached to the report (the KOBE-301 ledger's evidence). */
async function shoot(page: Page, name: string, cue: Locator): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await test.info().attach(`${name}-${theme}.png`, {
      body: await cue.screenshot({ animations: "disabled" }),
      contentType: "image/png",
    });
  }
  await page.evaluate(() => delete document.documentElement.dataset.theme);
}

test("status cues: a green Running badge and the rail's dot, also from another thread (KOBE-301)", async ({
  chat,
  page,
}) => {
  await chat.open();
  await chat.send(STORY);
  const threadId = await chat.threadId();

  // The header's badge: green, labelled, with a pulsing dot.
  const badge = page.locator('header [data-status-badge="running"]');
  await expect(badge).toBeVisible({ timeout: RUN_START_TIMEOUT_MS });
  await expect(badge).toHaveText("Running");
  expect(greenish(await rgbOf(badge))).toBe(true);
  const pulse = await badge
    .locator("[data-status-dot]")
    .evaluate((dot) => getComputedStyle(dot).animationName);
  expect(pulse).not.toBe("none");

  // The rail row: a green dot, and "Running" for screen readers.
  const row = page.locator(`li[data-kobe-thread="${threadId}"]`);
  const dot = row.locator('[data-status-dot="running"]');
  await expect(dot).toBeVisible();
  expect(greenish(await rgbOf(dot))).toBe(true);
  await expect(row.getByRole("button").first()).toHaveAccessibleDescription("Running");

  // The Stop button is tinted red while the run streams.
  const stop = chat.steering.locator("[data-kobe-stop]");
  await expect(stop).toBeVisible();
  expect(reddish(await rgbOf(stop))).toBe(true);

  await shoot(page, "header-badge", badge);
  await shoot(page, "rail-row", row);
  await shoot(page, "stop", stop);

  // Another conversation on screen: the rail still shows the run (read from the server).
  await chat.open();
  await expect(
    page.locator(`li[data-kobe-thread="${threadId}"] [data-status-dot="running"]`),
  ).toBeVisible();

  // Back to stop it; the dot goes once the run has ended.
  await page.goto(`/?thread=${threadId}`);
  await chat.steering.locator("[data-kobe-stop]").click();
  await chat.waitForIdle();
  await expect(page.locator(`li[data-kobe-thread="${threadId}"] [data-status-dot]`)).toHaveCount(0);
});

test("reduced motion stops the pulse", async ({ chat, page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await chat.open();
  await chat.send(STORY);
  const threadId = await chat.threadId();
  const dot = page.locator(`li[data-kobe-thread="${threadId}"] [data-status-dot="running"]`);
  await expect(dot).toBeVisible({ timeout: RUN_START_TIMEOUT_MS });
  expect(await dot.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  await chat.steering.locator("[data-kobe-stop]").click();
  await chat.waitForIdle();
});
