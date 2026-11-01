import type { Page } from "@playwright/test";
import { type Chat, expect, test } from "./support/chat.js";

/**
 * KOBE-537 (TLF-6, TL3): the lineage strip over three generations. One answered thread (the root)
 * forked twice from the same message (A and B), then B forked once more (C). On C the strip has
 * three rows: the root as a link, B as a siblings dropdown ("B · n of 2") and C bold with its fork
 * point. Switching by the link opens the root in place (its "2 forks" row); switching by the
 * dropdown opens A in place. The source and the three forks go to Trash in `finally`.
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

test("three generations: the strip's rows, switching by the link and by the dropdown", async ({
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

    // Two sibling forks of the root from the same answer (back to the root by the strip's link).
    const forkA = await fork(chat, page, first, source);
    await expect(stripOf(page).getByRole("listitem")).toHaveCount(2, { timeout: 30_000 });
    await openSource(chat, page, source, sourceTitle);
    await expect(stripOf(page)).toContainText(`1 fork: ${first}`);
    const forkB = await fork(chat, page, second, source);
    expect(forkB).not.toBe(forkA);
    await expect(stripOf(page).getByRole("listitem")).toHaveCount(2, { timeout: 30_000 });

    // A fork of the fork: C from B's answer.
    const forkC = await fork(chat, page, third, forkB);

    // On C: three rows. The root a link, B a siblings dropdown, C bold with its fork point.
    const rows = stripOf(page).getByRole("listitem");
    await expect(rows).toHaveCount(3, { timeout: 30_000 });
    await expect(rows.nth(0).getByRole("link", { name: sourceTitle, exact: true })).toBeVisible();
    const parent = rows.nth(1).getByRole("button", { name: new RegExp(`^${second} · [12] of 2`) });
    await expect(parent).toBeVisible();
    const current = rows.nth(2);
    await expect(current.locator('strong[aria-current="page"]')).toHaveText(third);
    await expect(current).toContainText(/ at “.+”/);

    // Switch by the link: the root opens in place and shows its "2 forks" row.
    await openSource(chat, page, source, sourceTitle);
    const forks = stripOf(page).getByRole("button", { name: "2 forks", exact: true });
    await expect(forks).toBeVisible({ timeout: 30_000 });
    await forks.click();
    const forksMenu = page.getByRole("menu", { name: "2 forks", exact: true });
    await expect(forksMenu.getByRole("menuitem")).toHaveCount(2);

    // Back to C: B from the forks menu, then B's "1 fork: C" link.
    await forksMenu.getByRole("menuitem", { name: second }).click();
    await expect.poll(() => threadParam(page), { timeout: FORK_TIMEOUT_MS }).toBe(forkB);
    await stripOf(page).getByRole("link", { name: third, exact: true }).click();
    await expect.poll(() => threadParam(page), { timeout: FORK_TIMEOUT_MS }).toBe(forkC);
    await expect(stripOf(page).getByRole("listitem")).toHaveCount(3, { timeout: 30_000 });

    // Switch by the dropdown: B's row lists both siblings, B checked; choosing A opens it in place.
    await stripOf(page)
      .getByRole("button", { name: new RegExp(`^${second} · [12] of 2`) })
      .click();
    const siblings = page.getByRole("menu");
    await expect(siblings.getByRole("menuitemradio")).toHaveCount(2);
    await expect(siblings.getByRole("menuitemradio", { name: second })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await siblings.getByRole("menuitemradio", { name: first }).click();
    await expect.poll(() => threadParam(page), { timeout: FORK_TIMEOUT_MS }).toBe(forkA);
    const onA = stripOf(page).getByRole("listitem");
    await expect(onA).toHaveCount(2, { timeout: 30_000 });
    await expect(onA.last()).toContainText(first);
  } finally {
    // The root and every fork seen (each read from the address) go to Trash.
    await chat.trashAll();
  }
});
