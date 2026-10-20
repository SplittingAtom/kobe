import type { Page } from "@playwright/test";
import { expect, test } from "./support/chat.js";
import { RUN_TIMEOUT_MS, SHELL_TIMEOUT_MS } from "./support/constants.js";
import { panelOf } from "./support/panel.js";

/**
 * KOBE-289: an approval remembered for "this conversation" lets the next share_file of that
 * conversation run without a card (its tool card says "Allowed by your rule (this conversation)"),
 * the rule is listed on My area, Approvals and on the team Policy page, and revoking it there
 * makes the next call ask again. The team's remember limits are left as they were.
 *
 * Needs `KOBE_USER` to be a team admin of the active team, with the team's ask-on-write default
 * (share_file asks by its risk class) and its remember limits allowing "this conversation".
 * Spends a few short model turns.
 */
const FILE = "/workspace/e2e-remember.txt";
const TEAM_KEY = "kobe.lastTeamId";

/** The caller's live remembered approvals in the active team, read from the page. */
async function myRules(page: Page): Promise<{ id: string; tool_glob: string }[]> {
  return page.evaluate(async (teamKey) => {
    const team = window.localStorage.getItem(teamKey);
    const res = await fetch("/v1/team/policy/my-rules", {
      headers: team ? { "x-kobe-team": team } : {},
    });
    return res.ok
      ? ((await res.json()) as { rules: { id: string; tool_glob: string }[] }).rules
      : [];
  }, TEAM_KEY);
}

/** Revokes every share_file rule the member has (clean-up, whatever happened). */
async function revokeAll(page: Page): Promise<void> {
  const rules = (await myRules(page)).filter((r) => r.tool_glob === "share_file");
  await page.evaluate(
    async ({ ids, teamKey }) => {
      const team = window.localStorage.getItem(teamKey);
      for (const id of ids) {
        await fetch(`/v1/team/policy/my-rules/${encodeURIComponent(id)}`, {
          method: "DELETE",
          headers: team ? { "x-kobe-team": team } : {},
        });
      }
    },
    { ids: rules.map((r) => r.id), teamKey: TEAM_KEY },
  );
}

test("remember for this conversation, run without a card, list, revoke, ask again", async ({
  chat,
  page,
}) => {
  test.setTimeout(4 * RUN_TIMEOUT_MS);
  await chat.open();
  // A share_file rule the member already has (any scope, made by hand or by an earlier run) would
  // let the first share run without a card: revoke them first.
  await revokeAll(page);
  expect((await myRules(page)).filter((r) => r.tool_glob === "share_file")).toEqual([]);
  try {
    await chat.send(
      `Use the write tool to create ${FILE} containing the word hi, then use the share_file tool to share ${FILE}. Then reply DONE.`,
    );
    const card = page.getByRole("group", { name: /Approval needed/ }).last();
    await expect(card).toBeVisible({ timeout: RUN_TIMEOUT_MS });
    await card.getByRole("checkbox", { name: /Remember: allow/ }).check();
    await card.getByLabel("Remember for").selectOption({ label: "this conversation" });
    await expect(card.getByText("Ends with this conversation.")).toBeVisible();
    await card.getByRole("button", { name: "Allow", exact: true }).click();
    await expect(page.getByText(/Approved and remembered/)).toBeVisible();
    await chat.waitForIdle();
    const threadId = await chat.threadId();

    // Same conversation: no card this time, and the tool card names the rule.
    const cards = await page.getByRole("group", { name: /Approval needed/ }).count();
    await chat.ask(`Use the share_file tool to share ${FILE} again. Then reply DONE.`);
    await expect(page.getByText("Allowed by your rule (this conversation).").first()).toBeVisible();
    expect(await page.getByRole("group", { name: /Approval needed/ }).count()).toBe(cards);

    // My area, Approvals lists it with its conversation.
    await page.goto("/me/approvals");
    const mine = panelOf(page).getByRole("table", { name: /Your remembered approvals/ });
    await expect(mine).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(mine).toContainText("share_file");
    await expect(mine).toContainText("this conversation");

    // The team Policy page shows it too; revoke it there.
    await page.goto("/admin/team/policy");
    const members = panelOf(page).getByRole("table", { name: /Remembered approvals/ });
    await expect(members).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await members
      .getByRole("button", { name: /rule for share_file/ })
      .first()
      .click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();
    await expect(panelOf(page).getByText(/Revoked: share_file/)).toBeVisible();
    expect((await myRules(page)).filter((r) => r.tool_glob === "share_file")).toEqual([]);

    // Back in the conversation, the next share asks again.
    await page.goto(`/?thread=${threadId}`);
    await expect(chat.composer).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await chat.send(`Use the share_file tool to share ${FILE} once more. Then reply DONE.`);
    const again = page.getByRole("group", { name: /Approval needed/ }).last();
    await expect(again.getByRole("button", { name: "Deny", exact: true })).toBeVisible({
      timeout: RUN_TIMEOUT_MS,
    });
    await again.getByRole("button", { name: "Deny", exact: true }).click();
    await chat.waitForIdle();
  } finally {
    await revokeAll(page);
  }
});
