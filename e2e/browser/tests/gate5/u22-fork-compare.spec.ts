import { RUN_TIMEOUT_MS, SHELL_TIMEOUT_MS } from "../support/constants.js";
import { expect, test } from "../support/chat.js";

/**
 * Gate 5, U22 (KOBE-227): "The first message is editable; a fork marker appears at every
 * multi-child entry; Fork to a new thread creates a thread with the copied entries and a working
 * back-link; Regenerate with another model produces a sibling, a marker, and switches the picker;
 * hidden for a pinned agent." root-edit, fork and regenerate-with specs prove most of it; the
 * marker, the back-link's target, the picker and the pinned agent are here. KOBE_GATE5_PINNED_THREAD
 * is a thread of the member's on an agent that pins its model (e2e/gate5.sh makes it).
 */
const PINNED_THREAD = process.env["KOBE_GATE5_PINNED_THREAD"];

test("U22: a fork marker at each entry with two branches", async ({ chat, page }) => {
  await chat.open();
  await chat.ask("No tools. Reply with the single word ALPHA.");
  await chat.ask("No tools. Reply with the single word GAMMA.");
  // Two branches at the first message (an edit) and two at the second answer (Regenerate).
  await (await chat.messageAction(chat.userMessages.first(), "Edit")).click();
  const edit = page.getByRole("textbox", { name: "Edit your message", exact: true });
  await edit.fill("No tools. Reply with the single word BETA.");
  await edit.press("Enter");
  await chat.waitForIdle();
  await chat.ask("No tools. Reply with the single word DELTA.");
  await (await chat.messageAction(chat.answers.last(), "Regenerate")).click();
  await chat.waitForIdle();
  await page.reload();
  await expect(chat.composer).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  const markers = page.locator('[data-kobe-marker="fork"]');
  await expect(markers).toHaveCount(2, { timeout: RUN_TIMEOUT_MS });
  for (const m of await markers.all()) await expect(m).toContainText("2 branches");
});

test("U22: the fork's back-link opens the source thread", async ({ chat, page }) => {
  await chat.open();
  const source = await chat.ask("No tools. Reply with the single word ORIGIN.");
  await (await chat.messageAction(chat.answers.last(), "Fork to a new thread")).click();
  const dialog = page.getByRole("dialog", { name: "Fork to a new thread" });
  await dialog.getByRole("button", { name: "Fork", exact: true }).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("thread"), { timeout: 60_000 })
    .not.toBe(source);
  await chat.threadId();
  await page.getByRole("note", { name: "Fork origin" }).getByRole("link").click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("thread"), { timeout: 30_000 })
    .toBe(source);
  await expect(chat.answers.last()).toContainText("ORIGIN");
});

test("U22: Regenerate with another model switches the conversation's model picker", async ({
  chat,
  page,
}) => {
  await chat.open();
  await chat.ask("No tools. Reply with the single word ALPHA.");
  const picker = (await chat.selectors()).getByRole("combobox", {
    name: "Model for this conversation",
  });
  // The picker is a <select>: its text is every option's; the choice is the checked option.
  const chosen = picker.locator("option:checked");
  const before = (await chosen.textContent())?.trim() ?? "";
  await (await chat.messageAction(chat.answers.last(), "Regenerate with…")).click();
  const menu = page.getByRole("menu", { name: "Regenerate with…" });
  const items = (await menu.getByRole("menuitem").allInnerTexts()).map((t) => t.trim());
  const other = items.find(
    (t) => !t.startsWith("Team default") && !t.endsWith("(current)") && t !== before,
  );
  test.skip(other === undefined, "the team needs a second enabled model");
  await menu.getByRole("menuitem", { name: other, exact: true }).click();
  await expect(page.getByText("Version 2 of 2", { exact: true })).toBeVisible({
    timeout: RUN_TIMEOUT_MS,
  });
  await chat.waitForIdle();
  const after = await chat.selectors();
  await expect(
    after.getByRole("combobox", { name: "Model for this conversation" }).locator("option:checked"),
  ).toHaveText(other ?? "");
});

test("U22: Regenerate with is hidden for an agent that pins its model", async ({ chat, page }) => {
  test.skip(!PINNED_THREAD, "set KOBE_GATE5_PINNED_THREAD (e2e/gate5.sh makes one)");
  await page.goto(`/?thread=${PINNED_THREAD}`);
  await expect(chat.composer).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  const answer = chat.answers.last();
  await expect(answer).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await answer.hover();
  await expect(answer.getByRole("button", { name: "Regenerate", exact: true })).toBeVisible();
  await expect(answer.getByRole("button", { name: "Regenerate with…", exact: true })).toHaveCount(
    0,
  );
});
