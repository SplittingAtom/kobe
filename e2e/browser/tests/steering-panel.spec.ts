import { RUN_START_TIMEOUT_MS, WAITING_FOR_AGENT } from "./support/constants.js";
import { expect, test } from "./support/chat.js";

/** Runs long enough for every queue action below to happen while it streams. */
const STORY =
  "No tools. Write a detailed 2000-word short story about a lighthouse keeper who finds a " +
  "message in a bottle.";
const ALPHA = "No tools. Reply with the single word ALPHA.";
const BRAVO = "No tools. Reply with the single word BRAVO.";

test("steering panel: queue, keyboard reorder, pause and resume, delete, stop", async ({
  chat,
  page,
}) => {
  const panel = chat.steering;
  const chips = page.locator("li[data-queued]");
  const button = (name: string) => panel.getByRole("button", { name, exact: true });
  const queuedAt = (position: number) =>
    panel.getByRole("button", { name: new RegExp(`^Edit queued message ${position}: `) });

  await chat.open();
  // Idle: the panel takes no room.
  await expect(panel).toHaveAttribute("data-state", "idle");
  expect((await panel.boundingBox())?.height ?? 0).toBeLessThan(2);

  await chat.send(STORY);
  await chat.threadId();
  await expect(panel).toHaveAttribute("data-state", /^(active|waiting)$/, {
    timeout: RUN_START_TIMEOUT_MS,
  });
  // Queue mode keeps the composer's toolbar on one line: Queue beside the selectors (KOBE-418).
  const queue = chat.toolbar.getByRole("button", { name: "Queue", exact: true });
  const model = chat.toolbar.getByRole("combobox", { name: "Model for this conversation" });
  const [q, m] = [await queue.boundingBox(), await model.boundingBox()];
  if (q && m) expect(Math.abs(q.y + q.height / 2 - (m.y + m.height / 2))).toBeLessThanOrEqual(4);
  await expect(button("Stop")).toBeVisible();

  // Messages sent while the run holds the thread queue as chips, in send order.
  await chat.send(ALPHA);
  await expect(chips).toHaveCount(1);
  await chat.send(BRAVO);
  await expect(chips).toHaveCount(2);
  await expect(queuedAt(1)).toHaveAccessibleName(/ALPHA/);
  await expect(queuedAt(2)).toHaveAccessibleName(/BRAVO/);

  // The grip reorders from the keyboard: Home moves the second chip first.
  await panel.getByRole("button", { name: "Move queued message 2", exact: true }).focus();
  await page.keyboard.press("Home");
  await expect(queuedAt(1)).toHaveAccessibleName(/BRAVO/);
  await expect(queuedAt(2)).toHaveAccessibleName(/ALPHA/);

  // Pause and resume.
  await button("Pause the queue").click();
  await expect(button("Resume queue")).toBeVisible();
  await expect(button("Pause the queue")).toBeHidden();
  await button("Resume queue").click();
  await expect(button("Pause the queue")).toBeVisible();
  await expect(chips).toHaveCount(2);

  // Delete both queued messages.
  await button("Delete queued message 1").click();
  await expect(chips).toHaveCount(1);
  await expect(queuedAt(1)).toHaveAccessibleName(/ALPHA/);
  await button("Delete queued message 1").click();
  await expect(chips).toHaveCount(0);

  // Stop ends the run; the panel folds away and nothing queued starts.
  await button("Stop").click();
  await chat.waitForIdle();
  await expect(panel).toHaveAttribute("data-state", "idle");
  await expect(chat.userMessages).toHaveCount(1);
  // The stopped run's message no longer waits for the agent (KOBE-288).
  await expect(page.getByText(WAITING_FOR_AGENT)).toHaveCount(0);
});
