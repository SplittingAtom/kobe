import { RUN_TIMEOUT_MS, SHELL_TIMEOUT_MS } from "./support/constants.js";
import { expect, test } from "./support/chat.js";

/** Compaction reads the whole conversation with a real model: allow for a slow one. */
const COMPACT_TIMEOUT_MS = 13 * 60_000;
const WORDS = ["harbour", "lamp", "keeper", "tide", "granite", "signal", "fog", "beacon"] as const;
/**
 * About 30k tokens: over Pi's 20k "keep recent" budget, so the short turn before it has something
 * to fold. A long turn alone answers `nothing_to_compact`.
 */
const FILLER = Array.from(
  { length: 2400 },
  (_, i) =>
    `Entry ${i}: the ${WORDS[i % WORDS.length]} log notes ${WORDS[(i * 3) % WORDS.length]} ` +
    `near the ${WORDS[(i * 5) % WORDS.length]}.`,
).join(" ");

test("Compact now folds the older turns into a summary marker", async ({ chat, page }) => {
  test.setTimeout(RUN_TIMEOUT_MS * 2 + COMPACT_TIMEOUT_MS + 2 * 60_000);
  const dialog = page.getByRole("dialog", { name: "Compact this thread" });
  const openDialog = async () => {
    await chat.openThreadActions();
    await page
      .locator("[data-thread-actions]")
      .getByRole("button", { name: /^Compact now/ })
      .click();
    await expect(dialog).toBeVisible();
  };
  /** "closed" once the dialog went away (success), else the refusal it shows. */
  const outcome = async () =>
    (await dialog.isHidden())
      ? "closed"
      : ((await dialog
          .getByRole("alert")
          .textContent()
          .catch(() => null)) ?? "pending");

  await chat.open();
  await chat.ask("No tools. In two sentences: what is a lighthouse? Mention the number 4217.");
  await chat.ask(`No tools. Reply only with the word OK. A long log to keep in mind: ${FILLER}`);
  // On gate1 the long message's optimistic copy can linger as a phantom "version 1 of 2" that
  // waits for the agent (ledger, KOBE-285); a reload shows the thread as the server keeps it.
  await page.reload();
  await expect(chat.composer).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await chat.waitForIdle();

  await openDialog();
  await dialog
    .getByRole("textbox", { name: "What should the summary keep? (optional)" })
    .fill("keep the number 4217");
  await dialog.getByRole("button", { name: "Compact now", exact: true }).click();
  await expect.poll(outcome, { timeout: COMPACT_TIMEOUT_MS, intervals: [2_000] }).toBe("closed");

  const marker = page.locator('[data-kobe-marker="compaction"]');
  await expect(marker).toBeVisible({ timeout: 30_000 });
  await expect(marker).toContainText("Context compacted");
  // The gauge is unknown again until the next model call.
  await expect(page.getByRole("meter", { name: "Context used" })).toHaveCount(0);
  // The marker opens to the summary.
  await marker.getByText("Context compacted").click();
  await expect(
    marker
      .locator("[data-kobe-summary]")
      .or(marker.getByText("The summary is too large to show here.")),
  ).toBeVisible();

  // Straight away again: nothing new to fold, and the dialog says so.
  await openDialog();
  await dialog.getByRole("button", { name: "Compact now", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible({ timeout: 2 * 60_000 });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
