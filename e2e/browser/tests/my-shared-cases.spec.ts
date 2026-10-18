import { expect, test } from "./support/chat.js";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";

/**
 * KOBE-276 ac-3: a member shares a thumbs down as an eval case, clears the rating (the chat no
 * longer offers Withdraw), finds the case under My shared cases and withdraws it there through
 * the console's confirm dialog. `KOBE_AGENT` is the name of a team agent KOBE_USER may chat with
 * (not a gallery agent). Spends one short model turn. Run on gate1:
 * `KOBE_AGENT=… npx playwright test my-shared-cases`.
 */
const AGENT = process.env["KOBE_AGENT"];

test("share, clear the rating, withdraw from My shared cases", async ({ chat, page }) => {
  test.skip(!AGENT, "set KOBE_AGENT to a team agent's name");
  await chat.open();
  // The agent picker sits in the composer's toolbar (KOBE-418).
  await (await chat.selectors()).getByRole("button", { name: /^Chat with:/ }).click();
  // The radio is visually hidden inside its option card: click the card (its label), as a
  // member does, then check the radio took it.
  // (`has` is matched inside each label, so the radio's locator starts from the page.)
  const picker = page.getByRole("radiogroup", { name: "Chat with" });
  const radio = page.getByRole("radio", { name: new RegExp(AGENT as string) });
  await picker.locator("label").filter({ has: radio }).click();
  await expect(picker.locator(radio)).toBeChecked();
  await page.keyboard.press("Escape");
  await chat.ask("No tools. Reply with the single word CASE.");
  const answer = chat.answers.last();
  await expect(answer).toContainText("CASE");

  const down = await chat.messageAction(answer, "Bad answer");
  await down.click();
  const form = page.getByRole("form", { name: "What went wrong?" });
  await form.getByRole("button", { name: "Wrong or made up", exact: true }).click();
  await form.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Share as an eval case…" }).click();
  const dialog = page.getByRole("dialog", { name: "Share as an eval case" });
  await dialog.getByRole("button", { name: "Share", exact: true }).click();
  await expect(page.getByText("Shared with the agent's owner as an eval case.")).toBeVisible();

  // Clearing the rating keeps the case; the chat no longer offers Withdraw.
  await down.click();
  await expect(down).toHaveAttribute("aria-pressed", "false");

  await page.goto("/me/shared-cases");
  await expect(page.getByRole("heading", { level: 1, name: "Shared cases" })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  const card = page.getByRole("listitem").filter({ hasText: "Reply with the single word CASE." });
  await expect(card.first()).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  const before = await card.count();
  await card
    .first()
    .getByRole("button", { name: /^Withdraw/ })
    .click();
  const confirm = page.getByRole("alertdialog", { name: "Withdraw this shared case?" });
  await confirm.getByRole("button", { name: "Withdraw", exact: true }).click();
  await expect(page.getByText("Withdrawn.")).toBeVisible();
  await expect(card).toHaveCount(before - 1);
});
