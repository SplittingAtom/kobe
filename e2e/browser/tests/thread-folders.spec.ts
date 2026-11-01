import type { Browser, Locator, Page } from "@playwright/test";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";
import { expect, test } from "./support/chat.js";

/**
 * KOBE-537 (TLF-6, TF7/TF8): the Threads panel's folder tree. The owner creates a folder inline,
 * files a thread from its row's ⋯ menu (Save to folder…), finds it under the folder and gone from
 * Current, deletes the folder and finds it back in Current. A second member (KOBE_USER2/KOBE_PW2,
 * skipped without them) sees the owner's folder and files a thread shared with them into it.
 * Each test deletes its folder and unshares in `finally`; the `chat` fixture trashes the threads.
 */
const SECOND_USER = process.env["KOBE_USER2"];
const SECOND_PW = process.env["KOBE_PW2"];
const TEAM_KEY = "kobe.lastTeamId";

/** Calls the API from the page (session cookie, Origin and team header as the chat sends them). */
async function api(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(
    async ({ method, path, body, teamKey }) => {
      const team = window.localStorage.getItem(teamKey) ?? "";
      const res = await fetch(path, {
        method,
        headers: { "x-kobe-team": team, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: (await res.json().catch(() => null)) as unknown };
    },
    { method, path, body, teamKey: TEAM_KEY },
  );
}

/** The team's folder named `name`, if it is there (`GET /v1/thread-folders`). */
async function folderId(page: Page, name: string): Promise<string | null> {
  const res = await api(page, "GET", "/v1/thread-folders");
  const folders = (res.json as { folders?: { id: string; name: string }[] } | null)?.folders;
  return folders?.find((f) => f.name === name)?.id ?? null;
}

/** Deletes the folder named `name` if it is still there; a clean-up step, so it never throws. */
async function removeFolder(page: Page, name: string): Promise<void> {
  try {
    const id = await folderId(page, name);
    if (id) await api(page, "DELETE", `/v1/thread-folders/${id}`);
  } catch (e) {
    console.warn(`could not delete the folder ${name} (${String(e)})`);
  }
}

async function shoot(page: Page, name: string, target: Locator): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await test.info().attach(`${name}-${theme}.png`, {
      body: await target.screenshot({ animations: "disabled" }),
      contentType: "image/png",
    });
  }
  await page.evaluate(() => delete document.documentElement.dataset.theme);
}

const panelOf = (page: Page) => page.getByRole("dialog", { name: "Threads" });
const treeOf = (page: Page) => panelOf(page).getByRole("tree", { name: "Thread folders" });
const nodeOf = (page: Page, name: string) =>
  treeOf(page).getByRole("treeitem", { name, exact: true });
/** The rows of the chosen node's list (the tree holds no thread rows). */
const rowOf = (page: Page, title: string) =>
  panelOf(page).locator("[data-kobe-thread]").filter({ hasText: title });

async function chooseNode(page: Page, name: string): Promise<void> {
  const node = nodeOf(page, name);
  await node.click();
  await expect(node).toHaveAttribute("aria-selected", "true");
}

/** Renames the open conversation from its header. */
async function rename(page: Page, title: string): Promise<void> {
  const header = page.locator("header").filter({ has: page.locator("#kobe-thread-title") });
  await header.getByRole("button", { name: /^Rename / }).click();
  const name = page.getByRole("textbox", { name: "Conversation name", exact: true });
  await name.fill(title);
  await name.press("Enter");
}

/** Opens a row's ⋯ menu and the submenu `item` (Save to folder…, Share). */
async function rowSubmenu(page: Page, row: Locator, title: string, item: string) {
  await row.hover();
  await row.getByRole("button", { name: `Actions for ${title}`, exact: true }).click();
  const menu = page.getByRole("menu", { name: `Actions for ${title}`, exact: true });
  const entry = menu.getByRole("menuitem", { name: item, exact: true });
  // Save to folder… waits for the team's folders to load.
  await expect(entry).not.toHaveAttribute("aria-disabled", "true");
  await entry.focus();
  await page.keyboard.press("ArrowRight");
  return page.getByRole("menu", { name: item, exact: true });
}

async function saveToFolder(page: Page, row: Locator, title: string, folder: string) {
  const folders = await rowSubmenu(page, row, title, "Save to folder…");
  await folders.getByRole("menuitem", { name: folder, exact: true }).click();
  await expect(panelOf(page).locator("[data-kobe-rail-status]")).toHaveText(
    `Saved “${title}” to ${folder}.`,
  );
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

test("create a folder, file a thread from its row menu, delete the folder", async ({
  chat,
  page,
}) => {
  const suffix = Date.now().toString(36);
  const title = `Filed ${suffix}`;
  const folder = `KOBE-537 ${suffix}`;

  await chat.open();
  await chat.ask("No tools. Reply with the single word FILED.");
  await rename(page, title);
  try {
    await chat.openThreads();
    await chooseNode(page, "Current");
    await expect(rowOf(page, title)).toHaveCount(1, { timeout: SHELL_TIMEOUT_MS });

    // + New folder: the inline editor below the tree; the new node is focused.
    await panelOf(page).getByRole("button", { name: "+ New folder", exact: true }).click();
    const field = panelOf(page).getByRole("textbox", { name: "New folder name", exact: true });
    await field.fill(folder);
    await field.press("Enter");
    await expect(nodeOf(page, folder)).toHaveCount(1);
    await expect(field).toHaveCount(0);

    // Save to folder… from the row's ⋯ menu: it leaves Current and is under the folder.
    await saveToFolder(page, rowOf(page, title), title, folder);
    await expect(rowOf(page, title)).toHaveCount(0);
    await chooseNode(page, folder);
    await expect(rowOf(page, title)).toHaveCount(1);
    await shoot(page, "thread-folders-filed", panelOf(page));
    await chooseNode(page, "Current");
    await expect(rowOf(page, title)).toHaveCount(0);

    // Delete (confirmed): the folder goes, the thread is back in Current.
    const node = nodeOf(page, folder);
    await node.hover();
    await node.getByRole("button", { name: `Actions for ${folder}`, exact: true }).click();
    const menu = page.getByRole("menu", { name: `Actions for ${folder}`, exact: true });
    await menu.getByRole("menuitem", { name: "Delete", exact: true }).click();
    const confirm = panelOf(page).getByRole("group", { name: "Delete folder" });
    await expect(confirm).toContainText(`Delete “${folder}”`);
    await confirm.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(nodeOf(page, folder)).toHaveCount(0);
    await expect(nodeOf(page, "Current")).toHaveAttribute("aria-selected", "true");
    await expect(rowOf(page, title)).toHaveCount(1);
  } finally {
    await removeFolder(page, folder);
  }
});

test("a second member sees the folder and files a thread shared with them", async ({
  chat,
  page,
  browser,
}) => {
  test.skip(!SECOND_USER || !SECOND_PW, "KOBE_USER2 and KOBE_PW2 name a second member");
  const suffix = Date.now().toString(36);
  const title = `Shared filed ${suffix}`;
  const folder = `KOBE-537 shared ${suffix}`;

  await chat.open();
  const threadId = await chat.ask("No tools. Reply with the single word SHARED.");
  await rename(page, title);
  let second: Page | null = null;
  try {
    // The owner's folder, and the thread shared with the team from its row's ⋯ menu.
    const made = await api(page, "POST", "/v1/thread-folders", { name: folder });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    await chat.openThreads();
    await chooseNode(page, "Current");
    await expect(rowOf(page, title)).toHaveCount(1, { timeout: SHELL_TIMEOUT_MS });
    const scopes = await rowSubmenu(page, rowOf(page, title), title, "Share");
    await scopes.getByRole("menuitem", { name: "Everyone in the team", exact: true }).click();
    await chat.closeThreads();
    await expect(page.getByRole("group", { name: "Sharing" })).toContainText(
      "Everyone in the team can read and fork",
    );

    second = await signInSecond(browser);
    await second.goto("/threads");
    await expect(panelOf(second)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    // The tree is the team's: the owner's folder is there.
    await expect(nodeOf(second, folder)).toHaveCount(1, { timeout: SHELL_TIMEOUT_MS });
    await chooseNode(second, "Current");
    const shared = panelOf(second)
      .getByRole("list", { name: "Shared with me", exact: true })
      .locator("[data-kobe-thread]")
      .filter({ hasText: title });
    await expect(shared).toHaveCount(1, { timeout: SHELL_TIMEOUT_MS });

    // A reader may file it (TF3): Save to folder… on the read-only row.
    await saveToFolder(second, shared, title, folder);
    await expect(shared).toHaveCount(0);
    await chooseNode(second, folder);
    await expect(shared).toHaveCount(1);
    await shoot(second, "thread-folders-shared", panelOf(second));
  } finally {
    // Unshared and the folder deleted; the fixture trashes the thread.
    await api(page, "POST", `/v1/threads/${threadId}/share`, { visibility: "private" }).catch(
      (e: unknown) => console.warn(`could not unshare ${threadId} (${String(e)})`),
    );
    await removeFolder(page, folder);
    await second?.context().close();
  }
});
