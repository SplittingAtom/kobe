import { expect, test } from "./support/chat.js";

test("Fork to a new thread opens a titled copy with its origin note", async ({ chat, page }) => {
  await chat.open();
  const source = await chat.ask("No tools. Reply with the single word ALPHA.");

  await (await chat.messageAction(chat.answers.last(), "Fork to a new thread")).click();
  const dialog = page.getByRole("dialog", { name: "Fork to a new thread" });
  await expect(dialog).toBeVisible();
  const title = `Fork check ${Date.now()}`;
  await dialog.getByRole("textbox", { name: "Title of the new thread", exact: true }).fill(title);
  await dialog.getByRole("button", { name: "Fork", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });

  // The chat opens the fork: another thread, tracked for clean-up too.
  await expect
    .poll(() => new URL(page.url()).searchParams.get("thread"), { timeout: 60_000 })
    .not.toBe(source);
  const fork = await chat.threadId();
  expect(fork).not.toBe(source);

  // The lineage chip (KOBE-535, TL3 as amended 2026-11-06): one chip naming the source, whose
  // menu lists the source (checked) and the fork on screen (checked).
  const strip = page.getByRole("navigation", { name: "Thread lineage" });
  const chip = strip.getByRole("button", { name: /^Forked from / });
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await chip.click();
  const family = page.getByRole("menu");
  await expect(family.getByRole("menuitemcheckbox")).toHaveCount(2);
  await expect(family.getByRole("menuitemcheckbox", { name: title })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.keyboard.press("Escape");
  // The conversation up to the fork point came along, and the rail lists the new title.
  await expect(chat.userMessages.first()).toContainText("ALPHA");
  await expect(chat.answers).toHaveCount(1);
  await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
});
