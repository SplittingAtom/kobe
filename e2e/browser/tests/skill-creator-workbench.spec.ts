import { expect, test } from "./support/chat.js";
import { RUN_TIMEOUT_MS, SHELL_TIMEOUT_MS } from "./support/constants.js";

/**
 * KOBE-442: skill-creator saves its skill straight into the Workbench. A Kobe-agent conversation
 * builds a small skill with skill-creator, which calls `save_skill_draft` after `validate.py`
 * passes; the tool card shows Open in Workbench, the link opens the member's private draft (started
 * from this conversation), and a second save from the same conversation updates that draft
 * instead of making another. The spec deletes the draft and trashes the thread at the end.
 *
 * Needs the active team's default agent to be Kobe (it carries skill-creator) with the team's
 * ask-on-write default (save_skill_draft runs without a card), and a sandbox image with
 * `skill_drafts` (KOBE-442). Spends a few model turns. Run on gate1:
 * `npx playwright test skill-creator-workbench`.
 */
const NAME = `e2e-sc-${Date.now().toString(36)}`;

test("skill-creator saves a private Workbench draft, and saving again updates it", async ({
  chat,
  page,
}) => {
  test.setTimeout(4 * RUN_TIMEOUT_MS);
  await chat.open();
  await chat.ask(
    [
      `Use the skill-creator skill to make a tiny skill named ${NAME} that answers with a haiku about the user's topic.`,
      "Do not ask me anything and skip the test runs: write SKILL.md (with a description that says when to use it)",
      "and evals/cases.yaml with one positive and one negative case, run validate.py,",
      "and when it passes save it to my Workbench. Then reply DONE.",
    ].join(" "),
  );
  const card = page.getByText(new RegExp(`^Skill draft saved: ${NAME}$`));
  await expect(card).toBeVisible({ timeout: RUN_TIMEOUT_MS });
  const open = page.getByRole("link", { name: "Open in Workbench" }).last();
  const href = await open.getAttribute("href");
  expect(href).toMatch(/^\/me\/skills\/drafts\/[0-9a-f-]{36}$/);

  // Saving again from the same conversation updates the same draft.
  await chat.ask(
    `Add the line "Keep it to three lines." to the end of the ${NAME} SKILL.md body, validate it and save it to my Workbench again. Then reply DONE.`,
  );
  await expect(page.getByText(new RegExp(`^Skill draft updated: ${NAME}$`))).toBeVisible({
    timeout: RUN_TIMEOUT_MS,
  });
  await expect(page.getByRole("link", { name: "Open in Workbench" }).last()).toHaveAttribute(
    "href",
    href ?? "",
  );

  // The link opens the private draft in the Workbench, with the second save's change.
  await page.getByRole("link", { name: "Open in Workbench" }).last().click();
  await expect(page.getByRole("heading", { level: 1, name: NAME })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await expect(page.getByLabel("Instructions (SKILL.md body)")).toHaveValue(
    /Keep it to three lines\./,
  );
  await page.goto("/me/skills?tab=workbench");
  await expect(page.getByRole("link", { name: NAME })).toHaveCount(1, {
    timeout: SHELL_TIMEOUT_MS,
  });

  // Clean-up: delete the draft (its thread goes to Trash with the chat fixture).
  await page.getByRole("link", { name: NAME }).click();
  await page.getByRole("button", { name: "Delete draft" }).click();
  await page
    .getByRole("alertdialog", { name: `Delete the draft ${NAME}?` })
    .getByRole("button", { name: "Delete draft" })
    .click();
  await expect(page).toHaveURL(/\/me\/skills\?tab=workbench$/);
});
