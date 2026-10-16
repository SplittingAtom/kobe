import type { Browser, Locator, Page } from "@playwright/test";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";
import { expect, test } from "./support/chat.js";

/**
 * KOBE-221 (CE20): the author shares a thread with the team from its row's ⋯ menu; a second member
 * finds it under Shared with me, opens it read-only with "Shared by <author>", forks it into a
 * thread of their own; the author revokes it and the second member loses it. Needs a second
 * member of the same team with a password: KOBE_USER2 and KOBE_PW2 (skipped without them).
 */
const SECOND_USER = process.env["KOBE_USER2"];
const SECOND_PW = process.env["KOBE_PW2"];
const TEAM_KEY = "kobe.lastTeamId";

const group = (page: Page, kind: string) => page.locator(`[data-group="${kind}"]`);
const rowIn = (page: Page, kind: string, title: string) =>
  group(page, kind).locator("[data-kobe-thread]").filter({ hasText: title });

/** Opens a row's Share submenu and picks `scope`. */
async function shareAs(page: Page, row: Locator, title: string, scope: string) {
  await row.hover();
  await row.getByRole("button", { name: `Actions for ${title}`, exact: true }).click();
  const menu = page.getByRole("menu", { name: `Actions for ${title}`, exact: true });
  const share = menu.getByRole("menuitem", { name: "Share", exact: true });
  await expect(share).not.toHaveAttribute("aria-disabled", "true");
  await share.focus();
  await page.keyboard.press("ArrowRight");
  const scopes = page.getByRole("menu", { name: "Share", exact: true });
  await scopes.getByRole("menuitem", { name: scope, exact: true }).click();
}

/** The second member, signed in in a fresh context (no saved session). */
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
  return page;
}

/** Moves a thread of the page's user to Trash through the chat's API (session, Origin, team). */
async function trash(page: Page, id: string): Promise<void> {
  await page.evaluate(
    async ({ id, teamKey }) => {
      const team = window.localStorage.getItem(teamKey) ?? "";
      await fetch(`/v1/threads/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "x-kobe-team": team },
      });
    },
    { id, teamKey: TEAM_KEY },
  );
}

test("share with the team, read and fork as another member, then revoke", async ({
  chat,
  page,
  browser,
}) => {
  test.skip(!SECOND_USER || !SECOND_PW, "KOBE_USER2 and KOBE_PW2 name a second member");
  const title = `Share ${Date.now().toString(36)}`;

  await chat.open();
  const threadId = await chat.ask("No tools. Reply with the single word SHARED.");
  const header = page.locator("header").filter({ has: page.locator("#kobe-thread-title") });
  await header.getByRole("button", { name: /^Rename / }).click();
  const name = page.getByRole("textbox", { name: "Conversation name", exact: true });
  await name.fill(title);
  await name.press("Enter");
  await expect(rowIn(page, "ungrouped", title)).toHaveCount(1);

  await shareAs(page, rowIn(page, "ungrouped", title), title, "Everyone in the team");
  const bar = page.getByRole("group", { name: "Sharing" });
  await expect(bar).toContainText("Everyone in the team can read and fork");

  const second = await signInSecond(browser);
  let forkId: string | null = null;
  try {
    // ac-2: the rail's Shared with me group lists it.
    await second.goto("/");
    await expect(rowIn(second, "shared", title)).toHaveCount(1, { timeout: SHELL_TIMEOUT_MS });

    // ac-1: read-only with the banner, no composer; Fork makes a private copy of their own.
    await second.goto(`/?thread=${threadId}`);
    const banner = second.getByRole("note", { name: "Shared thread" });
    await expect(banner).toContainText("Shared by", { timeout: SHELL_TIMEOUT_MS });
    await expect(banner).toContainText("read-only");
    await expect(second.locator('[data-role="assistant"]').first()).toContainText("SHARED");
    await expect(second.getByRole("textbox", { name: "Message", exact: true })).toHaveCount(0);
    await banner.getByRole("button", { name: "Fork into my conversations" }).click();
    await expect
      .poll(() => new URL(second.url()).searchParams.get("thread"), { timeout: 60_000 })
      .not.toBe(threadId);
    forkId = new URL(second.url()).searchParams.get("thread");
    await expect(second.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
    await expect(second.getByRole("note", { name: "Shared thread" })).toHaveCount(0);

    // Revoke: Only you. The second member loses the thread at once.
    await shareAs(page, rowIn(page, "ungrouped", title), title, "Only you");
    await expect(page.getByRole("group", { name: "Sharing" })).toHaveCount(0);
    await second.goto("/");
    await expect(second.getByRole("textbox", { name: "Message", exact: true })).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });
    await expect(rowIn(second, "shared", title)).toHaveCount(0);
    await second.goto(`/?thread=${threadId}`);
    await expect(second.getByRole("note", { name: "Shared thread" })).toHaveCount(0);
    await expect(second.locator('[data-role="assistant"]')).toHaveCount(0);
  } finally {
    if (forkId) await trash(second, forkId);
    await second.context().close();
  }
});
