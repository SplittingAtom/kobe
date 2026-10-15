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

  const origin = page.getByRole("note", { name: "Fork origin" });
  await expect(origin).toContainText("Forked from");
  await expect(origin.getByRole("link")).toHaveAttribute("href", new RegExp(source, "i"));
  // The conversation up to the fork point came along, and the rail lists the new title.
  await expect(chat.userMessages.first()).toContainText("ALPHA");
  await expect(chat.answers).toHaveCount(1);
  await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
});
