import { RUN_TIMEOUT_MS, SHELL_TIMEOUT_MS } from "./support/constants.js";
import { expect, test } from "./support/chat.js";
import { longAnswer } from "./support/gate5.js";

/**
 * KOBE-452: the consoles, My agents and Skills open as a large panel over the workspace instead of
 * a page of their own, so the member stays in context. `KOBE_USER` must be a team admin of the
 * active team (the Team console on the rail's top line). Runs against gate1 (README.md).
 */
/** The Team console's Members section (its h1). */
const MEMBERS = "Members and roles";
const panels = (page: import("@playwright/test").Page) => page.locator("[data-kobe-panel]");

test("a console opened mid-run returns to the same conversation state (ac-1, ac-4)", async ({
  chat,
  page,
}) => {
  await chat.open();
  await chat.send(longAnswer("No tools. Write a numbered list of 60 short lines about birds."));
  const thread = await chat.threadId();
  await chat.waitForBusy();
  await chat.composer.fill("a draft that waits");

  const opener = chat.railHeader.getByRole("link", { name: "Team console", exact: true });
  await opener.click();
  const panel = page.getByRole("dialog", { name: "Team console" });
  await expect(panel).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  expect(new URL(page.url()).pathname).toBe("/admin/team");
  // About 90% of the window, centred, over a dimmed workspace.
  const box = await panel.boundingBox();
  const view = page.viewportSize();
  expect(box && view && box.width / view.width).toBeGreaterThan(0.85);
  expect(box && view && box.width / view.width).toBeLessThan(0.95);
  await expect(page.locator("[data-kobe-panel-backdrop]")).toBeVisible();
  // Its own navigation moves the address; the run goes on underneath.
  await panel
    .getByRole("navigation", { name: "Team console sections" })
    .getByRole("link", { name: "Members and roles", exact: true })
    .click();
  await expect(page).toHaveURL(/\/admin\/team\/members$/);
  await test.info().attach("team-console-panel.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  await panel.getByRole("button", { name: "Close Team console" }).click();
  await expect(panels(page)).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("thread")).toBe(thread);
  await expect(chat.composer).toHaveValue("a draft that waits");
  await expect(opener).toBeFocused();
  // The run streamed on behind the panel and ends in this same tab, no reload.
  await chat.waitForIdle(RUN_TIMEOUT_MS);
  await expect(chat.answers.last()).not.toBeEmpty();
  // Back after Close never reopens the panel.
  await page.goBack();
  await expect(panels(page)).toHaveCount(0);
});

test("deep links, reload and Back (ac-2)", async ({ chat, page }) => {
  await chat.open();
  await chat.ask("No tools. Reply with the single word DEEP.");
  const thread = await chat.threadId();
  await page.goto("/admin/team/members");
  const panel = page.getByRole("dialog", { name: "Team console" });
  await expect(panel).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await page.reload();
  await expect(panel).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await expect(panel.getByRole("heading", { level: 1, name: MEMBERS })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await panel
    .getByRole("navigation", { name: "Team console sections" })
    .getByRole("link", { name: "Invitations", exact: true })
    .click();
  await expect(page).toHaveURL(/\/admin\/team\/invites$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/team\/members$/);
  await expect(panel.getByRole("heading", { level: 1, name: MEMBERS })).toBeVisible();
  // Opened by a link: Close shows the thread last on screen in this tab.
  await page.keyboard.press("Escape");
  await expect(panels(page)).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("thread")).toBe(thread);
  await expect(chat.answers.last()).toContainText("DEEP");
});

test("My agents and Skills open from the bar as panels; one at a time (ac-1, ac-3)", async ({
  chat,
  page,
}) => {
  await chat.open();
  await page.locator('[data-command="my-agents"]').click();
  await expect(page.getByRole("dialog", { name: "My agents" })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await page.keyboard.press("Escape");
  await expect(panels(page)).toHaveCount(0);
  await page.locator('[data-command="skills"]').click();
  const skills = page.getByRole("dialog", { name: "Skills" });
  await expect(skills).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await skills.getByRole("tab", { name: "Workbench" }).click();
  await expect(panels(page)).toHaveCount(1);
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await test.info().attach(`skills-panel-${theme}.png`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  }
  await page.evaluate(() => delete document.documentElement.dataset.theme);
  await skills.getByRole("button", { name: "Close Skills" }).click();
  await expect(panels(page)).toHaveCount(0);
});

test("on a phone the panel is a full-screen sheet (ac-3, ac-5)", async ({ chat, page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await chat.open();
  await page.goto("/me/agents");
  const panel = page.getByRole("dialog", { name: "My agents" });
  await expect(panel).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  expect((await panel.boundingBox())?.width).toBe(390);
  await panel.getByRole("button", { name: "Close My agents" }).click();
  await expect(chat.composer).toBeVisible();
});
