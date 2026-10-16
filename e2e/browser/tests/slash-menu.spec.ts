import { expect, test } from "./support/chat.js";
import { RUN_TIMEOUT_MS } from "./support/constants.js";

/**
 * KOBE-224 (CE22): `/` at the start of the composer opens the actions menu. `/fork` opens the
 * answer's own Fork dialog and leaves no `/` text in the composer; an unknown `/hello` lists
 * nothing and is sent to the agent as an ordinary message.
 */
test("/fork runs the Fork action; an unknown /hello is sent as text", async ({ chat, page }) => {
  await chat.open();
  await chat.ask("No tools. Reply with the single word ALPHA.");

  const actions = page.getByRole("listbox", { name: "Actions" });
  await chat.composer.pressSequentially("/fo");
  await expect(actions).toBeVisible();
  await expect(chat.composer).toHaveAttribute("aria-expanded", "true");
  await expect(
    actions.getByRole("option", { name: /^\/fork, Fork to a new thread/ }),
  ).toBeVisible();
  await chat.composer.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Fork to a new thread" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("up to this answer");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  // Nothing of the command reached the composer, so nothing of it can reach the prompt.
  await expect(chat.composer).toHaveValue("");

  // Escape closes the menu and keeps the text.
  await chat.composer.pressSequentially("/comp");
  await expect(actions.getByRole("option", { name: /^\/compact/ })).toBeVisible();
  await chat.composer.press("Escape");
  await expect(actions).toBeHidden();
  await expect(chat.composer).toHaveValue("/comp");
  await chat.composer.fill("");

  const before = await chat.answers.count();
  await chat.composer.pressSequentially("/hello No tools. Reply with the single word BRAVO.");
  await expect(actions).toBeHidden();
  await chat.composer.press("Enter");
  await expect(
    chat.userMessages.last().getByText("/hello No tools. Reply with the single word BRAVO."),
  ).toBeVisible();
  await expect
    .poll(() => chat.answers.count(), { timeout: RUN_TIMEOUT_MS })
    .toBeGreaterThan(before);
  await chat.waitForIdle();
});
