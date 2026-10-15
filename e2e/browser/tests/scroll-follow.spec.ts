import { RUN_TIMEOUT_MS } from "./support/constants.js";
import { expect, test } from "./support/chat.js";

/** Long enough to overflow the list and keep streaming while the test scrolls. */
const LONG_ANSWER =
  "No tools. Write a numbered list of 80 short lines, one per line, each naming a different " +
  "fruit with about ten words about it. No intro, no outro.";
/** Within this many pixels of the bottom the list counts as following (smooth scroll lags). */
const FOLLOW_SLACK_PX = 64;

test("the message list follows the stream, holds when scrolled up, and Jump to latest re-pins", async ({
  chat,
  page,
}) => {
  const list = chat.list;
  const gap = () => list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  const overflow = () => list.evaluate((el) => el.scrollHeight - el.clientHeight);
  const pageOverflow = () =>
    page.evaluate(() => {
      const root = document.scrollingElement ?? document.documentElement;
      return root.scrollHeight - root.clientHeight;
    });

  await chat.open();
  await chat.send(LONG_ANSWER);
  await chat.threadId();

  // The stream overflows the list, which scrolls on its own; the composer stays a fixed footer.
  await expect.poll(overflow, { timeout: RUN_TIMEOUT_MS, intervals: [500] }).toBeGreaterThan(400);
  await expect(list.locator("[data-kobe-composer]")).toHaveCount(0);
  await expect(page.locator("[data-kobe-composer]")).toBeInViewport();
  expect(await pageOverflow()).toBeLessThanOrEqual(1);

  // Following: pinned to the bottom as the answer grows.
  await expect(list).toHaveAttribute("data-kobe-follow", "pinned");
  for (let sample = 0; sample < 3; sample += 1) {
    await expect.poll(gap, { timeout: 5_000 }).toBeLessThan(FOLLOW_SLACK_PX);
    await page.waitForTimeout(700);
  }

  // A small scroll up unpins at once, while the answer streams or just as it ends (KOBE-288).
  const box = await list.boundingBox();
  if (box === null) throw new Error("the message list has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let step = 0; step < 5; step += 1) {
    await page.mouse.wheel(0, -40);
    await page.waitForTimeout(80);
  }
  await expect(list).toHaveAttribute("data-kobe-follow", "unpinned");
  const jump = page.getByRole("button", { name: /^Jump to latest/ });
  await expect(jump).toBeVisible();

  // Save tokens: stop the answer if it is still streaming. The run's end leaves the list unpinned
  // and the position where the member left it.
  const stop = chat.steering.getByRole("button", { name: "Stop", exact: true });
  if (await stop.isVisible()) await stop.click();
  await chat.waitForIdle();
  await expect(list).toHaveAttribute("data-kobe-follow", "unpinned");
  await expect(jump).toBeVisible();
  const heldAt = await list.evaluate((el) => el.scrollTop);
  await page.waitForTimeout(2_500);
  expect(Math.abs((await list.evaluate((el) => el.scrollTop)) - heldAt)).toBeLessThan(4);

  // The pill returns to the bottom and follows again.
  await jump.click();
  await expect(list).toHaveAttribute("data-kobe-follow", "pinned");
  await expect.poll(gap, { timeout: 10_000 }).toBeLessThan(FOLLOW_SLACK_PX);
  await expect(jump).toBeHidden();

  // On a phone the page still never scrolls and the composer stays on screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("[data-kobe-composer]")).toBeInViewport();
  expect(await pageOverflow()).toBeLessThanOrEqual(1);
});
