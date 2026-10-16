import { expect, test } from "./support/chat.js";

/**
 * KOBE-225 (CE23): Ctrl/Cmd+K opens the palette; an action runs from it (New conversation), a
 * thread opens by a word of it, chords run from the message box, and `?` opens the sheet with the
 * twelve shortcuts.
 */
test("the palette runs an action and opens a thread; ? lists twelve shortcuts", async ({
  chat,
  page,
}) => {
  await chat.open();
  const word = `zebra${Date.now()}`;
  const first = await chat.ask(`No tools. Reply with the single word ALPHA. (${word})`);

  const palette = page.getByRole("dialog", { name: "Command palette" });
  const field = palette.getByRole("combobox");

  // An action: New conversation leaves the thread for an empty draft.
  await page.locator("body").press("ControlOrMeta+k");
  await expect(palette).toBeVisible();
  await expect(field).toBeFocused();
  await field.pressSequentially("new conversation");
  await expect(palette.getByRole("option", { name: /^New conversation/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await field.press("Enter");
  await expect(palette).toBeHidden();
  await expect.poll(() => new URL(page.url()).searchParams.get("thread")).toBeNull();

  // A thread, found by a word of it (the thread search), opens on Enter.
  await page.locator("body").press("ControlOrMeta+k");
  await field.pressSequentially(word);
  const threads = palette.getByRole("group", { name: "Threads" });
  await expect(threads.getByRole("option").first()).toBeVisible({ timeout: 15_000 });
  // No action has the word, so the first thread is the first option, highlighted.
  await expect(threads.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await field.press("Enter");
  await expect(palette).toBeHidden();
  await expect.poll(() => new URL(page.url()).searchParams.get("thread")).toBe(first);
  await expect(chat.answers.last()).toContainText("ALPHA");

  // Chords work from the message box, where the focus usually is: Mod+B folds the rail.
  const rail = page.locator('aside[aria-label="Workspace"]');
  await chat.composer.focus();
  await chat.composer.press("ControlOrMeta+b");
  await expect(rail).toHaveAttribute("data-collapsed", "");
  await chat.composer.press("ControlOrMeta+b");
  await expect(rail).not.toHaveAttribute("data-collapsed", "");
  // Mod+[ goes to the previous conversation in the app, never Back in the browser.
  await chat.composer.press("ControlOrMeta+BracketLeft");
  await expect(page).toHaveURL(/\?thread=/);

  // The ? sheet lists the twelve, outside any text field.
  await chat.answers.last().click();
  await page.keyboard.press("?");
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator("[data-kobe-shortcut]")).toHaveCount(12);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
});
