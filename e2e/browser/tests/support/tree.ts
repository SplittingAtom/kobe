import { expect, type Browser, type Locator, type Page } from "@playwright/test";
import type { Chat } from "./chat.js";
import { RUN_START_TIMEOUT_MS, RUN_TIMEOUT_MS, SHELL_TIMEOUT_MS } from "./constants.js";

/**
 * Shared steps of the conversation tree specs (KOBE-549, CT3–CT18). Each spec file builds one
 * thread with two branches under the first answer:
 *
 *   ALPHA prompt → answer ─┬─ "Branch <token>" prompt → BRAVO answer   (the side branch)
 *                          └─ "Branch CHARLIE" prompt → CHARLIE answer (the leaf's branch)
 *
 * The side branch carries a word made for this run (`token`), so search finds it and nothing
 * else. Tests assert on the prompts and the structure, never on the model's words. Every test
 * leaves the leaf on the CHARLIE branch as it found it.
 */
export const SECOND_USER = process.env["KOBE_USER2"];
export const SECOND_PW = process.env["KOBE_PW2"];
export const NO_SECOND = "KOBE_USER2 and KOBE_PW2 name a second member of the team";
const TEAM_KEY = "kobe.lastTeamId";

export const LABEL = "try 5% cut";
export const MAIN = "CHARLIE";

export interface Branched {
  readonly threadId: string;
  /** Letters only (one word for full-text search), unique to this run, in the side prompt. */
  readonly token: string;
}

/** A word of letters only that no other thread holds. */
export function uniqueWord(prefix: string): string {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  let word = prefix;
  for (let i = 0; i < 10; i += 1) word += letters[Math.floor(Math.random() * letters.length)];
  return word;
}

export const firstPrompt = "No tools. Reply with the single word ALPHA.";
export const sidePrompt = (token: string) =>
  `Branch ${token}: no tools, reply with the single word BRAVO.`;
export const mainPrompt = `Branch ${MAIN}: no tools, reply with the single word ${MAIN}.`;

const messages = (page: Page) => page.locator('[data-role="user"], [data-role="assistant"]');
export const lastPrompt = (page: Page) => page.locator('[data-role="user"]').last();

/** The bar under the lineage strip while the head is off the leaf (CT3). */
export const branchBar = (page: Page) => page.getByRole("region", { name: "Another branch" });
/** The "Forked here · N branches" row with the branch picker ("Version n of m"). */
export const forkMarker = (page: Page) =>
  page.locator('[data-kobe-marker="fork"]').filter({ hasText: /Version \d+ of \d+/ });
export const treePanel = (page: Page) => page.getByRole("dialog", { name: "Conversation tree" });
/** A prompt's row in the wide tree: its accessible name is "You, <excerpt>, <time>, …". */
export const promptRow = (page: Page, mark: string) =>
  treePanel(page).getByRole("treeitem", { name: new RegExp(`^You, Branch ${mark}\\b`) });

/**
 * Sends from a branch point (Continue from here) and waits for the answer: the screen switches to
 * the new branch, so the answer count need not grow as `chat.ask` expects.
 */
export async function askOnNewBranch(chat: Chat, text: string, mark: string): Promise<void> {
  await chat.send(text);
  await expect(lastPrompt(chat.page)).toContainText(mark, { timeout: RUN_START_TIMEOUT_MS });
  await expect(messages(chat.page).last()).toHaveAttribute("data-role", "assistant", {
    timeout: RUN_TIMEOUT_MS,
  });
  await chat.waitForIdle();
}

/**
 * The thread of the file comment above: two prompts in a row, then Continue from here on the
 * first answer (its hover action; the chip and the dimmed messages below it) and the third
 * prompt, which lands as the second prompt's sibling and becomes the leaf.
 */
export async function buildBranchedThread(chat: Chat): Promise<Branched> {
  const page = chat.page;
  const token = uniqueWord("quokka");
  await chat.open();
  const threadId = await chat.ask(firstPrompt);
  await chat.ask(sidePrompt(token));
  await (await chat.messageAction(chat.answers.first(), "Continue from here")).click();
  await expect(page.getByText(/^Continuing from the answer at/)).toBeVisible();
  await expect(page.locator("[data-kobe-dimmed]").first()).toBeVisible();
  await askOnNewBranch(chat, mainPrompt, MAIN);
  await expect(page.getByText(/^Continuing from the answer at/)).toHaveCount(0);
  return { threadId, token };
}

/** Opens the tree from the conversation header's "⑂ Tree" button (CT12). */
export async function openTree(page: Page): Promise<Locator> {
  const panel = treePanel(page);
  if (await panel.isVisible()) return panel;
  const header = page.locator("header").filter({ has: page.locator("#kobe-thread-title") });
  await header.getByRole("button", { name: /^Conversation tree/ }).click();
  await expect(panel).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  return panel;
}

export async function closeTree(page: Page): Promise<void> {
  const panel = treePanel(page);
  if (!(await panel.isVisible())) return;
  await panel.getByRole("button", { name: "Close Conversation tree", exact: true }).click();
  await expect(panel).toBeHidden();
}

/** Opens a tree row's ⋯ (node menu) and returns the menu. */
export async function rowMenu(page: Page, row: Locator): Promise<Locator> {
  await row.hover();
  await row.getByRole("button", { name: /^Actions for / }).click();
  const menu = page.getByRole("menu").last();
  await expect(menu).toBeVisible();
  return menu;
}

/** Clicks the prompt's row in the tree: the head moves there, the tree closes (CT4). */
export async function showFromTree(page: Page, mark: string): Promise<void> {
  await openTree(page);
  await promptRow(page, mark).click();
  await expect(treePanel(page)).toBeHidden();
  await expect(lastPrompt(page)).toContainText(mark);
}

/** The conversation shows the side branch through the head: the bar is up. */
export async function expectBrowsing(page: Page, token: string): Promise<void> {
  await expect(branchBar(page)).toBeVisible();
  await expect(branchBar(page)).toContainText("Showing another branch");
  await expect(lastPrompt(page)).toContainText(token);
}

/** ✕ on the bar: back to the leaf's branch. */
export async function backToLeaf(page: Page): Promise<void> {
  await branchBar(page).getByRole("button", { name: "Back to the current branch" }).click();
  await expect(branchBar(page)).toHaveCount(0);
  await expect(lastPrompt(page)).toContainText(MAIN);
}

/** A reload starts at the leaf (the head is per tab): the conversation shows the leaf's branch. */
export async function expectLeafAfterReload(page: Page, mark: string): Promise<void> {
  await page.reload();
  await expect(lastPrompt(page)).toContainText(mark, { timeout: SHELL_TIMEOUT_MS });
  await expect(branchBar(page)).toHaveCount(0);
}

/** The bar's Make it current (POST /leaf): the bar goes once the leaf is there. */
export async function makeCurrentFromBar(page: Page): Promise<void> {
  await branchBar(page).getByRole("button", { name: "Make it current", exact: true }).click();
  await expect(branchBar(page)).toHaveCount(0, { timeout: 30_000 });
}

/** Label… from the prompt row's node menu (CT9); the row's name then carries the label. */
export async function labelPrompt(page: Page, mark: string, label: string): Promise<void> {
  const panel = await openTree(page);
  const menu = await rowMenu(page, promptRow(page, mark));
  await menu.getByRole("menuitem", { name: "Label…", exact: true }).click();
  const field = panel.getByRole("textbox", { name: "Label", exact: true });
  await field.fill(label);
  await panel.getByRole("button", { name: "Save label", exact: true }).click();
  await expect(field).toHaveCount(0);
  await expect(promptRow(page, mark)).toHaveAttribute("aria-label", new RegExp(escape(label)));
}

/** Remove label from the node menu; a clean-up step too, so it does nothing without a label. */
export async function removeLabel(page: Page, mark: string, label: string): Promise<void> {
  await openTree(page);
  const row = promptRow(page, mark);
  if (!((await row.getAttribute("aria-label")) ?? "").includes(label)) return;
  const menu = await rowMenu(page, row);
  await menu.getByRole("menuitem", { name: "Remove label", exact: true }).click();
  await expect(row).not.toHaveAttribute("aria-label", new RegExp(escape(label)));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Calls the API from the page (session cookie, Origin and team header as the chat sends them). */
export async function api(page: Page, method: string, path: string, body?: unknown) {
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

/** Shares the thread read-only with the team, or back to private (`POST /share`). */
export async function share(page: Page, threadId: string, visibility: "team" | "private") {
  const res = await api(page, "POST", `/v1/threads/${threadId}/share`, { visibility });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
}

/** The second member, signed in in a fresh context (no saved session), on the shared thread. */
export async function openAsSecond(browser: Browser, threadId: string): Promise<Page> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(SECOND_USER ?? "");
  await page.getByLabel("Password").fill(SECOND_PW ?? "");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), {
    timeout: SHELL_TIMEOUT_MS,
  });
  await page.goto(`/?thread=${threadId}`);
  await expect(page.getByRole("note", { name: "Shared thread" })).toContainText("read-only", {
    timeout: SHELL_TIMEOUT_MS,
  });
  await expect(lastPrompt(page)).toContainText(MAIN);
  return page;
}
