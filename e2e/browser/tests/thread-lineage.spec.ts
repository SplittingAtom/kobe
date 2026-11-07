import type { Page } from "@playwright/test";
import { type Chat, expect, test } from "./support/chat.js";

/**
 * KOBE-537 (TLF-6, TL3 as amended 2026-11-06): the lineage chip over three generations. One
 * answered thread (the root) forked twice from the same message (A and B), then B forked once more
 * (C). On C the chip names B, and its menu holds the whole family (root, A and B, C) with the path
 * checked. Choosing the root opens it in place (its chip then reads "2 forks"); choosing A from
 * C's menu opens A in place. The source and the three forks go to Trash in `finally`.
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

/** The chip's family menu, opened. */
async function openFamily(page: Page) {
  await stripOf(page).getByRole("button").click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  return menu;
}

/** Opens the source from the chip's menu and waits until it is on screen. */
async function openSource(chat: Chat, page: Page, source: string, title: string) {
  const menu = await openFamily(page);
  await menu.getByRole("menuitemcheckbox", { name: title, exact: true }).click();
  await expect.poll(() => threadParam(page), { timeout: FORK_TIMEOUT_MS }).toBe(source);
  expect(await chat.threadId()).toBe(source);
}

test("three generations: the chip, switching by its menu from the root and from a fork", async ({
  chat,
  page,
}) => {
  const suffix = Date.now().toString(36);
  const sourceTitle = `Lineage ${suffix}`;
  const first = `Lineage fork A ${suffix}`;
  const second = `Lineage fork B ${suffix}`;
  const third = `Lineage fork C ${suffix}`;

  try {
    await chat.open();
    const source = await chat.ask("No tools. Reply with the single word ALPHA.");
    const header = page.locator("header").filter({ has: page.locator("#kobe-thread-title") });
    await header.getByRole("button", { name: /^Rename / }).click();
    const name = page.getByRole("textbox", { name: "Conversation name", exact: true });
    await name.fill(sourceTitle);
    await name.press("Enter");
    await expect(page.locator("#kobe-thread-title")).toHaveText(sourceTitle);

    // Two sibling forks of the root from the same answer (back to the root by the chip's menu).
    const forkA = await fork(chat, page, first, source);
    const chipOf = (name: string | RegExp) => stripOf(page).getByRole("button", { name });
    await expect(chipOf(`Forked from ${sourceTitle}`)).toBeVisible({ timeout: 30_000 });
    await openSource(chat, page, source, sourceTitle);
    await expect(chipOf("1 fork")).toBeVisible({ timeout: 30_000 });
    const forkB = await fork(chat, page, second, source);
    expect(forkB).not.toBe(forkA);
    await expect(chipOf(`Forked from ${sourceTitle}`)).toBeVisible({ timeout: 30_000 });

    // A fork of the fork: C from B's answer.
    const forkC = await fork(chat, page, third, forkB);

    // On C: the chip names B; the menu holds root, A and B (B checked), then C checked.
    await expect(chipOf(`Forked from ${second}`)).toBeVisible({ timeout: 30_000 });
    const family = await openFamily(page);
    const items = family.getByRole("menuitemcheckbox");
    await expect(items).toHaveCount(4);
    await expect(items.nth(0)).toHaveText(sourceTitle);
    await expect(items.nth(3)).toHaveText(third);
    await expect(family.getByRole("menuitemcheckbox", { name: second })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(family.getByRole("menuitemcheckbox", { name: first })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await page.keyboard.press("Escape");

    // From C to the root by the menu: the root's chip counts its two forks.
    await openSource(chat, page, source, sourceTitle);
    await expect(chipOf("2 forks")).toBeVisible({ timeout: 30_000 });
    const forksMenu = await openFamily(page);
    await expect(forksMenu.getByRole("menuitemcheckbox")).toHaveCount(3);

    // Back to C: B from the root's menu, then C from B's menu.
    await forksMenu.getByRole("menuitemcheckbox", { name: second }).click();
    await expect.poll(() => threadParam(page), { timeout: FORK_TIMEOUT_MS }).toBe(forkB);
    await (await openFamily(page)).getByRole("menuitemcheckbox", { name: third }).click();
    await expect.poll(() => threadParam(page), { timeout: FORK_TIMEOUT_MS }).toBe(forkC);
    await expect(chipOf(`Forked from ${second}`)).toBeVisible({ timeout: 30_000 });

    // Switch to a sibling of the parent: A from C's menu opens it in place.
    await (await openFamily(page)).getByRole("menuitemcheckbox", { name: first }).click();
    await expect.poll(() => threadParam(page), { timeout: FORK_TIMEOUT_MS }).toBe(forkA);
    await expect(chipOf(`Forked from ${sourceTitle}`)).toBeVisible({ timeout: 30_000 });
  } finally {
    // The root and every fork seen (each read from the address) go to Trash.
    await chat.trashAll();
  }
});
