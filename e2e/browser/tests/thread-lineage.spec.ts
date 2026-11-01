import type { Page } from "@playwright/test";
import { type Chat, expect, test } from "./support/chat.js";

/**
 * KOBE-537 (TLF-6, TL3): the lineage strip. One answered thread forked twice from the same
 * message: the second fork's strip has the source as a link and itself bold with "n of 2"
 * siblings; the source's link opens it in place, where a "2 forks" row lists both and opens one.
 * The `chat` fixture trashes the source and both forks (each is read from the address).
 */
const FORK_TIMEOUT_MS = 60_000;

const stripOf = (page: Page) => page.getByRole("navigation", { name: "Thread lineage" });
const threadParam = (page: Page) => new URL(page.url()).searchParams.get("thread");

/** Forks the last answer into a thread titled `title`; returns the fork's id once it is open. */
async function fork(chat: Chat, page: Page, title: string, from: string): Promise<string> {
  await (await chat.messageAction(chat.answers.last(), "Fork to a new thread")).click();
  const dialog = page.getByRole("dialog", { name: "Fork to a new thread" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Title of the new thread", exact: true }).fill(title);
  await dialog.getByRole("button", { name: "Fork", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: FORK_TIMEOUT_MS });
  await expect.poll(() => threadParam(page), { timeout: FORK_TIMEOUT_MS }).not.toBe(from);
  return chat.threadId();
}

/** Opens the source from the strip's first row (its link) and waits until it is on screen. */
async function openSource(chat: Chat, page: Page, source: string, title: string) {
  const link = stripOf(page).getByRole("listitem").first().getByRole("link", { name: title });
  await expect(link).toHaveAttribute("href", new RegExp(source, "i"));
  await link.click();
  await expect.poll(() => threadParam(page), { timeout: FORK_TIMEOUT_MS }).toBe(source);
  expect(await chat.threadId()).toBe(source);
  await expect(stripOf(page).locator('strong[aria-current="page"]')).toHaveText(title);
}

test("fork twice: the strip's rows, siblings, the source link and the forks menu", async ({
  chat,
  page,
}) => {
  const suffix = Date.now().toString(36);
  const sourceTitle = `Lineage ${suffix}`;
  const first = `Lineage fork A ${suffix}`;
  const second = `Lineage fork B ${suffix}`;

  await chat.open();
  const source = await chat.ask("No tools. Reply with the single word ALPHA.");
  const header = page.locator("header").filter({ has: page.locator("#kobe-thread-title") });
  await header.getByRole("button", { name: /^Rename / }).click();
  const name = page.getByRole("textbox", { name: "Conversation name", exact: true });
  await name.fill(sourceTitle);
  await name.press("Enter");
  await expect(page.locator("#kobe-thread-title")).toHaveText(sourceTitle);

  // First fork, then back to the source by the strip's link, and the second from the same answer.
  const forkA = await fork(chat, page, first, source);
  await expect(stripOf(page).getByRole("listitem")).toHaveCount(2, { timeout: 30_000 });
  await openSource(chat, page, source, sourceTitle);
  await expect(stripOf(page)).toContainText(`1 fork: ${first}`);
  const forkB = await fork(chat, page, second, source);
  expect(forkB).not.toBe(forkA);

  // On the second fork: two rows, the source a link, the fork bold as "n of 2" siblings.
  const rows = stripOf(page).getByRole("listitem");
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
  await expect(rows.first().getByRole("link", { name: sourceTitle, exact: true })).toBeVisible();
  const siblings = rows.last().getByRole("button", { name: new RegExp(`^${second} · [12] of 2`) });
  await expect(siblings).toBeVisible();
  await expect(rows.last()).toContainText(/ at “.+”/);
  await siblings.click();
  const siblingMenu = page.getByRole("menu");
  await expect(siblingMenu.getByRole("menuitemradio")).toHaveCount(2);
  await expect(siblingMenu.getByRole("menuitemradio", { name: second })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(siblingMenu).toHaveCount(0);

  // The source by its link, in place: its strip ends with "2 forks ▾"; choosing one opens it.
  await openSource(chat, page, source, sourceTitle);
  const forks = stripOf(page).getByRole("button", { name: "2 forks", exact: true });
  await expect(forks).toBeVisible({ timeout: 30_000 });
  await forks.click();
  const forksMenu = page.getByRole("menu", { name: "2 forks", exact: true });
  await expect(forksMenu.getByRole("menuitem")).toHaveCount(2);
  await forksMenu.getByRole("menuitem", { name: first }).click();
  await expect.poll(() => threadParam(page), { timeout: FORK_TIMEOUT_MS }).toBe(forkA);
  await expect(stripOf(page).getByRole("listitem").last()).toContainText(first);
});
