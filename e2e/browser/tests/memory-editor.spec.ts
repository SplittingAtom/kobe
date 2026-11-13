import { expect, test } from "@playwright/test";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";
import { panelOf } from "./support/panel.js";

/**
 * KOBE-384: the Me editor on the Memories tab of My memory, in the panel over the workspace. One
 * memory goes through add (with the 'Use in all my workspaces?' confirmation shown and declined
 * first) → edit → pin → archive → restore, with Undo once, and focus checked where the editor
 * promises it. The memory's text is unique per run; it is left archived at the end (memories are
 * never deleted). Needs the Memories switches on for KOBE_USER's active workspace. Spends no
 * tokens. Run on gate1: `npx playwright test memory-editor`.
 */
const ONLY_HERE = "Only in this workspace";

test("Memories: add, edit, pin, archive and restore one memory", async ({ page }) => {
  const text = `Prefers e2e answers ${Date.now()}`;
  const edited = `${text} (edited)`;
  await page.goto("/me/memory");
  const panel = panelOf(page);
  await expect(panel.getByRole("tab", { name: "Memories", selected: true })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  const group = panel.getByRole("region", { name: ONLY_HERE });
  await expect(group.getByText(/^Loading/)).toHaveCount(0, { timeout: SHELL_TIMEOUT_MS });

  // The portable confirmation shows the text; declining sends nothing.
  await panel.getByLabel("New memory").fill(text);
  await panel.getByRole("checkbox", { name: /Use in all my workspaces/ }).check();
  await panel.getByRole("button", { name: "Save memory" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Use in all my workspaces?" });
  await expect(confirm).toContainText(text);
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);

  // Add to this workspace only.
  await panel.getByRole("checkbox", { name: /Use in all my workspaces/ }).uncheck();
  await panel.getByRole("button", { name: "Save memory" }).click();
  await expect(panel.getByText("Memory saved.")).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  const row = group.getByRole("listitem", { name: text });
  await expect(row).toBeVisible();

  // Edit: focus lands in the text, and back on Edit after Save; Undo brings the text back.
  await row.getByRole("button", { name: `Edit: ${text}` }).click();
  const box = panel.getByLabel("Memory text");
  await expect(box).toBeFocused();
  await box.fill(edited);
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  const editedRow = group.getByRole("listitem", { name: edited });
  await expect(editedRow).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await expect(editedRow.getByRole("button", { name: `Edit: ${edited}` })).toBeFocused();
  await panel.getByRole("button", { name: "Undo" }).click();
  await expect(panel.getByText("Undone.")).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await expect(group.getByRole("listitem", { name: text })).toBeVisible();

  // Pin: listed first, pressed, focus kept.
  const pin = row.getByRole("button", { name: `Pin: ${text}` });
  await pin.click();
  await expect(panel.getByText("Pinned.")).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  const pinned = group.getByRole("button", { name: `Pin: ${text}` });
  await expect(pinned).toHaveAttribute("aria-pressed", "true");
  await expect(pinned).toBeFocused();
  await expect(group.getByRole("listitem").first()).toHaveAttribute("aria-label", text);

  // Archive: focus to the group; restore from the archive; archive again to leave it tidy.
  await group.getByRole("button", { name: `Archive: ${text}` }).click();
  await expect(panel.getByRole("heading", { name: ONLY_HERE })).toBeFocused({
    timeout: SHELL_TIMEOUT_MS,
  });
  await group.getByRole("button", { name: `Show archived (${ONLY_HERE})` }).click();
  const archive = group.getByRole("list", { name: `Archived: ${ONLY_HERE}` });
  await archive.getByRole("button", { name: `Restore: ${text}` }).click();
  await expect(panel.getByText("Restored.")).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await expect(
    group.getByRole("list", { name: ONLY_HERE }).getByRole("listitem", { name: text }),
  ).toBeVisible();
  await group
    .getByRole("list", { name: ONLY_HERE })
    .getByRole("button", { name: `Archive: ${text}` })
    .click();
  await expect(panel.getByText("Archived.")).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await expect(panel.getByRole("alert")).toHaveCount(0);
});
