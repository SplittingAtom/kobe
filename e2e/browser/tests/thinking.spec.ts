import { expect, test } from "./support/chat.js";

/**
 * KOBE-260: a conversation's thinking level. Needs a model whose site settings let members pick
 * a level (Site → Models: a reasoning model with a thinking control, thinking allowed) and that
 * the team enabled; the spec looks for one in the model picker and skips itself without one.
 * With the Off pill pressed the answer has no reasoning block and the run records `off`.
 */
const PROMPT = "No tools. Reply with the single word ALPHA.";
const TEAM_KEY = "kobe.lastTeamId";

test("thinking off: the answer has no reasoning block and the run records off", async ({
  chat,
  page,
}) => {
  await chat.open();
  // A new conversation: in the composer's toolbar (KOBE-418), or its folded menu on a narrow
  // window.
  const selectors = await chat.selectors();
  const models = selectors.getByRole("combobox", { name: "Model for this conversation" });
  // KOBE-556: the level is a row of pills (assistant-ui's Reasoning effort), one per level.
  const thinking = selectors.getByRole("group", {
    name: "Thinking level for this conversation",
  });
  const values = await models
    .locator("option")
    .evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value));
  let found = false;
  for (const value of values) {
    await models.selectOption(value);
    if (await thinking.isVisible()) {
      found = true;
      break;
    }
  }
  test.skip(!found, "no enabled model lets members pick a thinking level");
  await thinking.getByRole("button", { name: "Off", exact: true }).click();

  const threadId = await chat.ask(PROMPT);
  await chat.waitForIdle();
  const answer = chat.answers.last();
  await expect(answer).toContainText("ALPHA");
  await expect(answer.getByText("Reasoning", { exact: true })).toHaveCount(0);

  // The conversation keeps the choice; the run was clamped to and recorded at off.
  const recorded = await page.evaluate(
    async ({ id, teamKey }) => {
      const team = window.localStorage.getItem(teamKey);
      const headers = team ? { "x-kobe-team": team } : undefined;
      const [thread, usage] = await Promise.all([
        fetch(`/v1/threads/${encodeURIComponent(id)}?limit=1`, { headers }).then((r) => r.json()),
        fetch(`/v1/threads/${encodeURIComponent(id)}/usage`, { headers }).then((r) => r.json()),
      ]);
      return {
        chosen: (thread as { thinking_level?: string | null }).thinking_level ?? null,
        runs: ((usage as { runs: { thinking_level?: string | null }[] }).runs ?? []).map(
          (r) => r.thinking_level ?? null,
        ),
      };
    },
    { id: threadId, teamKey: TEAM_KEY },
  );
  expect(recorded).toEqual({ chosen: "off", runs: ["off"] });
  // After the first prompt the selectors sit below the composer (KOBE-450), still on off.
  const below = (await chat.selectors()).getByRole("group", {
    name: "Thinking level for this conversation",
  });
  await expect(below.getByRole("button", { name: "Off", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // KOBE-574: the pills alone, no spend bar or readout once a run has spent.
  await expect(below.getByRole("progressbar")).toHaveCount(0);
});
