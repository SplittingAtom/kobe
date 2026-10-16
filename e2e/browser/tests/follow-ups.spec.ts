import type { Page } from "@playwright/test";
import { expect, test } from "./support/chat.js";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";

/**
 * KOBE-222 (CE21): with the team's Follow-ups switch on (Team console, off by default), the server
 * asks the thread's model for three follow-ups after each answer; they show as chips above the
 * composer, a chip sends its text, and the chips go until the next answer. The switch is turned
 * back off at the end, whatever happens. Needs a team admin (`KOBE_USER`) whose budgets are all
 * under 80 % (follow-ups are skipped from there on).
 */
const PROMPT = "No tools. Reply with the single word ALPHA.";
/** The follow-up call runs after the run (up to 20 s), and the event follows within the window. */
const FOLLOWUPS_TIMEOUT_MS = 45_000;
const TEAM_KEY = "kobe.lastTeamId";

/** Turns the team switch on or off in the Team console, as a team admin would. */
async function setSwitch(page: Page, on: boolean): Promise<void> {
  await page.goto("/admin/team/follow-ups");
  const toggle = page.getByRole("checkbox", { name: /Suggest follow-up messages/ });
  await expect(toggle).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  if ((await toggle.isChecked()) === on) return;
  await toggle.setChecked(on);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText(on ? /Follow-up suggestions are on/ : /Follow-up suggestions are off/),
  ).toBeVisible();
}

/** The switch as the server has it (read from the page, with the session cookie). */
async function switchState(page: Page): Promise<boolean | null> {
  return page.evaluate(async (teamKey) => {
    const team = window.localStorage.getItem(teamKey);
    const res = await fetch("/v1/team/settings", { headers: team ? { "x-kobe-team": team } : {} });
    return res.ok ? ((await res.json()) as { followups_enabled: boolean }).followups_enabled : null;
  }, TEAM_KEY);
}

test("follow-ups: the team switch on, chips after the answer, a chip sends, the switch off again", async ({
  chat,
  page,
}) => {
  await setSwitch(page, true);
  try {
    expect(await switchState(page)).toBe(true);
    await chat.open();
    await chat.ask(PROMPT);

    const chips = page.getByRole("group", { name: "Suggested follow-ups" });
    await expect(chips).toBeVisible({ timeout: FOLLOWUPS_TIMEOUT_MS });
    const buttons = chips.getByRole("button");
    const count = await buttons.count();
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(3);
    const text = (await buttons.first().innerText()).trim();
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(120);

    // A chip sends its text as the next message; the chips go with the send.
    const before = await chat.userMessages.count();
    await buttons.first().click();
    await expect(chips).toBeHidden();
    await expect(chat.userMessages).toHaveCount(before + 1);
    await expect(chat.userMessages.last()).toContainText(text);
    await chat.waitForIdle();
  } finally {
    await setSwitch(page, false);
  }
  expect(await switchState(page)).toBe(false);
});
