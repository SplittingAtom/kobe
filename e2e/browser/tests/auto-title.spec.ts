import { expect, test } from "./support/chat.js";

/**
 * KOBE-219 (CE18): a new conversation is created untitled; after its first answer the server asks
 * the thread's model for a title through the model gateway, and the rail and the header show it
 * without a reload. Until then the rail shows the first line of the first message. Hovering the
 * row shows its card: first message, agent, last activity and message count.
 */
const PROMPT = "No tools. Reply with the single word ALPHA.";
/** The title call runs after the run (up to 15 s), and the event follows within the window. */
const TITLE_TIMEOUT_MS = 45_000;
const TEAM_KEY = "kobe.lastTeamId";

test("a new thread gets its title after the first answer, in the rail and the header", async ({
  chat,
  page,
}) => {
  await chat.open();
  const threadId = await chat.ask(PROMPT);

  // The header leaves the first line for the server's title, live.
  const heading = page.locator("#kobe-thread-title");
  await expect
    .poll(async () => (await heading.innerText()).trim(), { timeout: TITLE_TIMEOUT_MS })
    .not.toMatch(/^(No tools\. Reply with the single word ALPHA\.|Untitled conversation)$/);
  const title = (await heading.innerText()).trim();
  expect(title.length).toBeGreaterThan(0);
  expect(title.length).toBeLessThanOrEqual(80);

  // The server saved it (unlocked: no rename was sent) and the rail lists it.
  const saved = await page.evaluate(
    async ({ id, teamKey }) => {
      const team = window.localStorage.getItem(teamKey);
      const res = await fetch(`/v1/threads/${encodeURIComponent(id)}?limit=1`, {
        headers: team ? { "x-kobe-team": team } : {},
      });
      return res.ok ? ((await res.json()) as { title: string | null }).title : null;
    },
    { id: threadId, teamKey: TEAM_KEY },
  );
  expect(saved).toBe(title);
  const row = page.getByRole("list", { name: "Your threads" }).getByRole("button", {
    name: title,
    exact: true,
  });
  await expect(row).toBeVisible();

  // The row's hover card: the first message and the counts, read when it opens.
  await row.hover();
  const card = page.getByTestId("thread-card");
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card).toContainText(PROMPT);
  await expect(card).toContainText("Agent");
  await expect(card).toContainText("Last activity");
  await expect(card).toContainText(/Messages\s*2/);
});
