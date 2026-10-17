import { expect, test } from "./support/chat.js";

/**
 * KOBE-275 ac-1: thumbs up and down on an answer. The rating is saved on the click and survives a
 * reload; a thumbs down offers reason chips and a short comment; the pressed thumb clears it.
 * (Langfuse scores, ac-5, are checked in the Langfuse UI on gate1: docs/ledger/KOBE-275.md.)
 */
test("rate an answer up, then down with a reason and a comment, reload, clear", async ({
  chat,
  page,
}) => {
  await chat.open();
  const threadId = await chat.ask("No tools. Reply with the single word RATED.");
  const answer = chat.answers.last();
  await expect(answer).toContainText("RATED");

  // The thumbs appear once the thread's rateable answers are read (after the run ended).
  const up = await chat.messageAction(answer, "Good answer");
  await up.click();
  await expect(up).toHaveAttribute("aria-pressed", "true");

  const down = await chat.messageAction(answer, "Bad answer");
  await down.click();
  await expect(down).toHaveAttribute("aria-pressed", "true");
  await expect(up).toHaveAttribute("aria-pressed", "false");
  const form = page.getByRole("form", { name: "What went wrong?" });
  await expect(form).toBeVisible();
  await form.getByRole("button", { name: "Didn't follow instructions", exact: true }).click();
  await form.getByLabel("Comment (only you see it)").fill("It said more than one word.");
  await form.getByRole("button", { name: "Send", exact: true }).click();
  await expect(form).toHaveCount(0);

  // A reload reads the rating back.
  await page.goto(`/?thread=${threadId}`);
  const again = chat.answers.last();
  await expect(again).toContainText("RATED", { timeout: 45_000 });
  const downAgain = await chat.messageAction(again, "Bad answer");
  await expect(downAgain).toHaveAttribute("aria-pressed", "true");

  // The pressed thumb clears it, and it stays cleared.
  await downAgain.click();
  await expect(downAgain).toHaveAttribute("aria-pressed", "false");
  await page.reload();
  const cleared = await chat.messageAction(chat.answers.last(), "Bad answer");
  await expect(cleared).toHaveAttribute("aria-pressed", "false");
});
