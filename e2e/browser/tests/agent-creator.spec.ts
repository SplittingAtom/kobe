import { expect, test, type Browser, type Page } from "@playwright/test";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";
import { panelOf } from "./support/panel.js";
import { pinTeam } from "./support/team.js";

/**
 * KOBE-476: the two-tab personal agent creator under My Agents. The signed-in owner (KOBE_USER, a
 * site Owner) creates an agent across both tabs (Identity, then Behaviour), picks an icon, chooses
 * a connector and moves one of its tools to Denied, saves, reloads and finds it all kept; the
 * Approval mode offers Dangerous. The second member (KOBE_USER2, not an admin) is not offered
 * Dangerous. Spends no model tokens; the agent is deleted at the end. Needs a connector enabled in
 * the team (gate1: catalyst_2 in Team1). Run on gate1: `npx playwright test agent-creator`.
 */
const SECOND_USER = process.env["KOBE_USER2"];
const SECOND_PW = process.env["KOBE_PW2"];
const TEAM_KEY = "kobe.lastTeamId";

const tab = (page: Page, name: "Identity" | "Behaviour") =>
  panelOf(page).getByRole("tab", { name, exact: true });

async function openCreator(page: Page): Promise<void> {
  await page.goto("/me/agents/new");
  await expect(
    panelOf(page).getByRole("heading", { level: 1, name: "New personal agent" }),
  ).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
}

async function approvalModes(page: Page): Promise<string[]> {
  await tab(page, "Behaviour").click();
  return panelOf(page).getByLabel("Approval mode").locator("option").allTextContents();
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

async function signInSecond(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(SECOND_USER ?? "");
  await page.getByLabel("Password").fill(SECOND_PW ?? "");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), {
    timeout: SHELL_TIMEOUT_MS,
  });
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await pinTeam(page);
  return page;
}

test("create an agent across both tabs, deny a tool, save and reload", async ({ page }) => {
  const name = `Creator ${Date.now().toString(36)}`;
  await openCreator(page);
  const panel = panelOf(page);

  // Identity.
  await expect(tab(page, "Identity")).toHaveAttribute("aria-selected", "true");
  await panel.getByLabel("Name", { exact: true }).fill(name);
  await panel.getByLabel("Role", { exact: true }).fill("Checks the creator end to end");
  await panel.getByRole("button", { name: /^Icon/ }).click();
  await panel.getByRole("searchbox", { name: "Search icons" }).fill("rocket");
  await panel.getByRole("list", { name: "Icons" }).getByRole("button", { name: "rocket" }).click();
  await panel.getByLabel("System prompt", { exact: true }).fill("You check the agent creator.");

  // Behaviour: the owner (an admin) is offered Dangerous.
  expect(await approvalModes(page)).toContainEqual(expect.stringMatching(/^Dangerous/));
  await expect(panel.getByRole("button", { name: "Create agent" })).toBeVisible();
  const add = panel.getByRole("combobox", { name: "Add a connector" });
  await expect(add).toBeEnabled({ timeout: SHELL_TIMEOUT_MS });
  const options = (await add.locator("option").allTextContents()).slice(1);
  test.skip(options.length === 0, "needs a connector enabled in the team");
  await add.selectOption({ label: options[0] as string });
  const allowed = panel.getByRole("list", { name: "Allowed tools" });
  await expect(allowed.getByRole("listitem").first()).toBeVisible();
  const tool = (await allowed.getByRole("listitem").first().locator("code").textContent()) ?? "";
  expect(tool).toMatch(/^mcp__/);
  await panel.getByRole("button", { name: `Deny ${tool}`, exact: true }).click();
  await expect(panel.getByRole("list", { name: "Denied tools" }).getByText(tool)).toBeVisible();

  const created = page.waitForResponse(
    (r) => r.url().endsWith("/v1/agents") && r.request().method() === "POST",
  );
  await panel.getByRole("button", { name: "Create agent" }).click();
  const res = await created;
  expect(res.status()).toBe(201);
  const id = ((await res.json()) as { agent: { id: string } }).agent.id;
  try {
    await page.waitForURL(`**/me/agents/${id}`, { timeout: SHELL_TIMEOUT_MS });
    await page.reload();
    await expect(panel.getByLabel("Name", { exact: true })).toHaveValue(name, {
      timeout: SHELL_TIMEOUT_MS,
    });
    await expect(panel.getByRole("button", { name: /^Icon/ })).toContainText("rocket");
    await tab(page, "Behaviour").click();
    await expect(panel.getByRole("list", { name: "Denied tools" }).getByText(tool)).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });
    await expect(panel.getByRole("list", { name: "Allowed tools" }).getByText(tool)).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Save draft" })).toBeVisible();
  } finally {
    await deleteAgent(page, id);
  }
});

test("a member who is not an admin is not offered Dangerous", async ({ browser }) => {
  test.skip(!SECOND_USER || !SECOND_PW, "KOBE_USER2 and KOBE_PW2 name a second member");
  const page = await signInSecond(browser);
  try {
    await openCreator(page);
    const modes = await approvalModes(page);
    expect(modes).toContain("Ask on write");
    expect(modes).not.toContainEqual(expect.stringMatching(/^Dangerous/));
  } finally {
    await page.context().close();
  }
});
