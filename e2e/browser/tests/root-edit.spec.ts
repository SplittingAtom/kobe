import { RUN_TIMEOUT_MS, SHELL_TIMEOUT_MS } from "./support/constants.js";
import { expect, test } from "./support/chat.js";

test("editing the first message makes version 2 of 2, which survives a reload", async ({
  chat,
  page,
}) => {
  const versions = (n: number) => page.getByText(`Version ${n} of 2`, { exact: true });

  await chat.open();
  await chat.ask("No tools. Reply with the single word ALPHA.");

  const first = chat.userMessages.first();
  await (await chat.messageAction(first, "Edit")).click();
  const edit = page.getByRole("textbox", { name: "Edit your message", exact: true });
  await edit.fill("No tools. Reply with the single word BETA.");
  await edit.press("Enter");

  await expect(chat.userMessages.first()).toContainText("BETA");
  await expect(versions(2)).toBeVisible();
  await expect(chat.answers.last()).toContainText(/beta/i, { timeout: RUN_TIMEOUT_MS });
  await chat.waitForIdle();
  await expect(chat.userMessages).toHaveCount(1);

  // The server keeps the new branch as the thread's leaf.
  await page.reload();
  await expect(chat.composer).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await expect(chat.userMessages.first()).toContainText("BETA");
  await expect(versions(2)).toBeVisible();

  // The first version is still there.
  await page.getByRole("button", { name: "Previous version", exact: true }).first().click();
  await expect(versions(1)).toBeVisible();
  await expect(chat.userMessages.first()).toContainText("ALPHA");
});
