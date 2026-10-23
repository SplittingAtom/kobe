import { expect, test, type Page } from "@playwright/test";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";
import { panelOf } from "./support/panel.js";

/**
 * KOBE-494: a site admin (KOBE_USER, the gate1 Owner) edits a gallery agent in the Site Console.
 * Gallery agents → Edit opens the two-tab agent creator; the spec adds a marker to the system
 * prompt, saves the draft (the agent is now Customized), publishes a new version, sees the
 * Customized badge in the list, and checks that a fork made now copies the new version. At the end
 * it deletes the fork and resets the agent to the repository definition (asked first), which
 * publishes the repository definition again. Spends no model tokens. Run on gate1:
 * `npx playwright test site-gallery-edit`.
 */
const GALLERY = "/admin/site/gallery";
const AGENT = process.env["KOBE_GALLERY_AGENT"] ?? "Kobe";
const TEAM_KEY = "kobe.lastTeamId";

async function openGallery(page: Page): Promise<void> {
  await page.goto(GALLERY);
  await expect(
    panelOf(page).getByRole("heading", { level: 1, name: "Gallery agents" }),
  ).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
}

/** Forks the gallery agent into a personal agent through the API; returns its id and prompt. */
async function forkAgent(page: Page, id: string): Promise<{ id: string; prompt: string }> {
  return page.evaluate(
    async ({ id, teamKey }) => {
      const res = await fetch(`/v1/agents/${encodeURIComponent(id)}/fork`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-kobe-team": window.localStorage.getItem(teamKey) ?? "",
        },
        body: JSON.stringify({ scope: "personal" }),
      });
      const body = (await res.json()) as { agent: { id: string; prompt: string } };
      return { id: body.agent.id, prompt: body.agent.prompt };
    },
    { id, teamKey: TEAM_KEY },
  );
}

async function deleteAgent(page: Page, id: string): Promise<void> {
  await page.evaluate(
    async ({ id, teamKey }) => {
      await fetch(`/v1/agents/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "x-kobe-team": window.localStorage.getItem(teamKey) ?? "" },
      });
    },
    { id, teamKey: TEAM_KEY },
  );
}

test("a site admin edits a gallery agent, publishes it and resets it to the repository", async ({
  page,
}) => {
  const marker = `KOBE-494 e2e ${Date.now()}`;
  const panel = panelOf(page);
  let forkId: string | null = null;

  await openGallery(page);
  await panel.getByRole("link", { name: `Edit ${AGENT}`, exact: true }).click();
  await expect(panel.getByRole("heading", { level: 1, name: AGENT })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  const agentId = decodeURIComponent(new URL(page.url()).pathname.split("/").pop() ?? "");
  // The two tabs of the agent creator (KOBE-476).
  await expect(panel.getByRole("tab", { name: "Identity", exact: true })).toBeVisible();
  await expect(panel.getByRole("tab", { name: "Behaviour", exact: true })).toBeVisible();

  try {
    const prompt = panel.getByLabel("System prompt");
    const before = await prompt.inputValue();
    await prompt.fill(`${before}\n\n${marker}`);
    await panel.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect(panel.getByText("Draft saved.")).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(panel.getByText("Customized", { exact: true })).toBeVisible();

    await panel.getByRole("button", { name: "Publish…", exact: true }).click();
    const ask = page.getByRole("alertdialog", { name: `Publish ${AGENT} to every team?` });
    await ask.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(panel.getByText(/^Published v\d+\.$/)).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });

    // The list shows it Customized.
    await openGallery(page);
    const row = panel.getByRole("row").filter({ hasText: AGENT });
    await expect(row.getByText("Customized", { exact: true })).toBeVisible();

    // A team forking it now gets the new version.
    const fork = await forkAgent(page, agentId);
    forkId = fork.id;
    expect(fork.prompt).toContain(marker);
  } finally {
    if (forkId) await deleteAgent(page, forkId);
    // Restore: Reset to repository, asked first, from the editor.
    await page.goto(`${GALLERY}/${encodeURIComponent(agentId)}`);
    const reset = panel.getByRole("button", { name: `Reset to repository (${AGENT})` });
    await expect(reset).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await reset.click();
    const confirm = page.getByRole("alertdialog", {
      name: `Reset ${AGENT} to the repository definition?`,
    });
    await confirm.getByRole("button", { name: "Reset to repository", exact: true }).click();
    await expect(panel.getByText("Customized", { exact: true })).toBeHidden({
      timeout: SHELL_TIMEOUT_MS,
    });
    await expect(panel.getByLabel("System prompt")).not.toHaveValue(new RegExp(marker));
  }
});
