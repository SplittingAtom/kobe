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
  // A finished thread to switch to later, inside the app (no page load).
  await chat.open();
  await chat.ask("No tools. Reply with the single word OK.");
  const otherId = await chat.threadId();
  await chat.open();
  await chat.send(STORY);
  const threadId = await chat.threadId();
  const rowButton = (id: string) =>
    page.locator(`li[data-kobe-thread="${id}"]`).getByRole("button").first();

  // The header's badge: green, labelled, with a pulsing dot.
  const badge = page.locator('header [data-status-badge="running"]');
  await expect(badge).toBeVisible({ timeout: RUN_START_TIMEOUT_MS });
  await expect(badge).toHaveText("Running");
  expect(greenish(await rgbOf(badge))).toBe(true);
  const pulse = await badge
    .locator("[data-status-dot]")
    .evaluate((dot) => getComputedStyle(dot).animationName);
  expect(pulse).not.toBe("none");

  // With the rows in the Threads panel (KOBE-453), its button on the rail carries the activity.
  // On a shared site another thread may be waiting for an approval, which outranks running (the
  // rail shows the most urgent activity); either way the button carries the overall activity.
  const threadsButton = chat.railHeader.getByRole("button", {
    name: /^Threads panel, a conversation (is running|is waiting for your approval)$/,
  });
  await expect(threadsButton).toHaveAttribute("data-kobe-activity", /^(running|approval)$/);

  // The row in the Threads panel: a green dot, and "Running" for screen readers.
  await chat.openThreads();
  const row = page.locator(`li[data-kobe-thread="${threadId}"]`);
  const dot = row.locator('[data-status-dot="running"]');
  await expect(dot).toBeVisible();
  expect(greenish(await rgbOf(dot))).toBe(true);
  await expect(row.getByRole("button").first()).toHaveAccessibleDescription("Running");

  await shoot(page, "rail-row", row);
  await chat.closeThreads();

  // The Stop button is tinted red while the run streams.
  const stop = chat.steering.locator("[data-kobe-stop]");
  await expect(stop).toBeVisible();
  expect(reddish(await rgbOf(stop))).toBe(true);

  await shoot(page, "header-badge", badge);
  await shoot(page, "stop", stop);

  // Another conversation opened from the Threads panel, in the app: the dot stays, from the live
  // activity read (the run's own stream is closed once its thread is off screen).
  await chat.openThreads();
  await rowButton(otherId).click();
  await expect(page).toHaveURL(new RegExp(`thread=${otherId}`));
  await chat.openThreads();
  const away = page.locator(`li[data-kobe-thread="${threadId}"] [data-status-dot="running"]`);
  await expect(away).toBeVisible();
  await expect(rowButton(threadId)).toHaveAccessibleDescription("Running");

  // Back to it (again in the app) to stop it; the dot goes once the run has ended.
  await rowButton(threadId).click();
  await expect(page).toHaveURL(new RegExp(`thread=${threadId}`));
  await chat.steering.locator("[data-kobe-stop]").click();
  await chat.waitForIdle();
  await chat.openThreads();
  await expect(page.locator(`li[data-kobe-thread="${threadId}"] [data-status-dot]`)).toHaveCount(0);
});

test("reduced motion stops the pulse", async ({ chat, page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await chat.open();
  await chat.send(STORY);
  const threadId = await chat.threadId();
  await chat.openThreads();
  const dot = page.locator(`li[data-kobe-thread="${threadId}"] [data-status-dot="running"]`);
  await expect(dot).toBeVisible({ timeout: RUN_START_TIMEOUT_MS });
  expect(await dot.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  await chat.closeThreads();
  await chat.steering.locator("[data-kobe-stop]").click();
  await chat.waitForIdle();
});
