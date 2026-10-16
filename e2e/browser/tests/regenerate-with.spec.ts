import { RUN_TIMEOUT_MS, SHELL_TIMEOUT_MS } from "./support/constants.js";
import { expect, test } from "./support/chat.js";

const DEFAULT_ITEM = /^Team default/;
const CURRENT = "(current)";

test("Regenerate with another model adds version 2 under a Model changed to marker", async ({
  chat,
  page,
}) => {
  await chat.open();
  await chat.ask("No tools. Reply with the single word ALPHA.");

  await (await chat.messageAction(chat.answers.last(), "Regenerate with…")).click();
  const menu = page.getByRole("menu", { name: "Regenerate with…" });
  await expect(menu).toBeVisible();
  const items = (await menu.getByRole("menuitem").allInnerTexts()).map((t) => t.trim());
  // The team default is the current choice of a new conversation; pick a model other than it.
  const defaultName = /^Team default \(([^)]*)\)/.exec(
    items.find((t) => DEFAULT_ITEM.test(t)) ?? "",
  );
  const other = items.find(
    (t) => !DEFAULT_ITEM.test(t) && !t.endsWith(CURRENT) && t !== defaultName?.[1],
  );
  test.skip(other === undefined, "the team needs a second enabled model");
  await menu.getByRole("menuitem", { name: other, exact: true }).click();

  // The thread's first model reads "Model: …" (KOBE-280); the switch is the one change marker.
  const changes = page.locator('[data-kobe-marker="model"]', { hasText: "Model changed to" });
  await expect(changes).toHaveCount(1, { timeout: RUN_TIMEOUT_MS });
  await expect(page.getByText("Version 2 of 2", { exact: true })).toBeVisible({
    timeout: RUN_TIMEOUT_MS,
  });
  await chat.waitForIdle();
  await expect(chat.answers).toHaveCount(1);

  // The marker and the new version are the thread's record, not client state.
  await page.reload();
  await expect(chat.composer).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await expect(changes).toHaveCount(1);
  await expect(page.getByText("Version 2 of 2", { exact: true })).toBeVisible();
});
