import { RUN_TIMEOUT_MS } from "./support/constants.js";
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
  // KOBE-418: Compact now is an icon beside the latest answer's thumbs down, enabled while idle.
  const openDialog = async () => {
    await expect(chat.compactNow).toHaveAttribute("aria-disabled", "false");
    await chat.compactNow.click();
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
  // The long message is streamed without its body (over 64 KiB): the copy shown from the send
  // must give way to the stored entry, with no second version and nothing waiting (KOBE-288).
  await expect(page.getByText(/^Version \d+ of \d+$/)).toHaveCount(0);
  await expect(chat.userMessages).toHaveCount(2);

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
  // The marker opens to the summary. It follows the Detail toggle, which is stored per member
  // (KOBE-208): already open when Detail is on, where a click would close it (KOBE-302).
  const header = marker.getByRole("button", { name: /Context compacted/ });
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(
    marker
      .locator("[data-kobe-summary]")
      .or(marker.getByText("The summary is too large to show here.")),
  ).toBeVisible();
  // A click closes it and the next opens it again.
  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");

  // Only the latest answer offers it.
  await expect(
    chat.answers.first().getByRole("button", { name: "Compact now", exact: true }),
  ).toHaveCount(0);
  // Straight away again: nothing new to fold, and the dialog says so.
  await openDialog();
  await dialog.getByRole("button", { name: "Compact now", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible({ timeout: 2 * 60_000 });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  // Focus returns to the answer's button.
  await expect(chat.compactNow).toBeFocused();
});
