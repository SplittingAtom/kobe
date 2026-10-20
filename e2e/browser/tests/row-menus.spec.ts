import type { Locator, Page } from "@playwright/test";
import { expect, test, filesSection } from "./support/chat.js";
import { expectThemed, paintOf, type Theme } from "./support/colours.js";

/**
 * KOBE-292: the rail's row menus. A thread row and a Files row each have one ⋯ button that opens
 * a menu (the menu button pattern: keyboard opens it, arrows move, Escape closes it and gives the
 * button its focus back), painted in light and dark. The conversation header renames the thread
 * in place and the rail follows. Copy puts the conversation on the clipboard as Markdown.
 */
const THEME_COOKIE = "kobe-theme";
// KOBE-220 added Pin, Move to project and Archive; KOBE-221 added Share.
const THREAD_ITEMS = [
  "Copy",
  "Regenerate",
  "Regenerate with",
  "Pin",
  "Move to project",
  "Archive",
  "Share",
  // KOBE-322: start a skill from this conversation, or save a built one to the Workbench.
  "Make a skill from this",
  "Save skill to Workbench",
  "Delete",
];
// KOBE-374 added Mention in message; KOBE-304 Rename and Move to….
const FILE_ITEMS = [
  "Open",
  "Mention in message",
  "Download",
  "Rename",
  "Move to…",
  "Copy path",
  "Delete",
];

const themeToggle = (page: Page) =>
  page.getByRole("button", { name: "Dark theme", exact: true }).first();

const itemNames = async (menu: Locator) =>
  (await menu.getByRole("menuitem").allInnerTexts()).map((t) => t.trim());

/** Hovers `row`, opens its ⋯ menu from the keyboard, checks it, and closes it with Escape. */
async function checkRowMenu(
  page: Page,
  row: Locator,
  label: string,
  items: readonly string[],
  theme: Theme,
): Promise<void> {
  await row.hover();
  const button = row.getByRole("button", { name: label, exact: true });
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute("aria-haspopup", "menu");
  await button.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: label, exact: true });
  await expect(menu).toBeVisible();
  expect(await itemNames(menu)).toEqual(items);
  expectThemed(`${label} menu`, await paintOf(menu), theme);
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem").nth(1)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(button).toBeFocused();
}

test("thread and file row menus in light and dark; header rename; Copy as Markdown", async ({
  chat,
  page,
  context,
}) => {
  await context.clearCookies({ name: THEME_COOKIE });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const suffix = Date.now().toString(36);
  const title = `Row menus ${suffix}`;
  const fileName = `kobe-292-${suffix}.txt`;

  await chat.open();
  await chat.ask("No tools. Reply with the single word OK.");

  // The header's pencil renames in place; the rail shows the new name at once.
  const header = page.locator("header").filter({ has: page.locator("#kobe-thread-title") });
  await header.getByRole("button", { name: /^Rename / }).click();
  const name = page.getByRole("textbox", { name: "Conversation name", exact: true });
  await name.fill(title);
  await name.press("Enter");
  await expect(page.getByRole("heading", { level: 2, name: title, exact: true })).toBeVisible();
  // The thread rows are in the Threads panel (KOBE-453), the file rows in the rail.
  const threads = chat.threadsPanel.getByRole("list", { name: "Your threads" });
  const threadRow = threads.getByRole("listitem").filter({ hasText: title });
  await chat.openThreads();
  await expect(threadRow).toHaveCount(1);
  await chat.closeThreads();

  // A file of our own in the workspace root, for its row's menu.
  const files = filesSection(page);
  await files.getByLabel("Upload a file to the workspace root").setInputFiles({
    name: fileName,
    mimeType: "text/plain",
    buffer: Buffer.from("KOBE-292 row menu check\n"),
  });
  // Since KOBE-304 the panel is an ARIA tree: the file is a treeitem named after it.
  const fileRow = files
    .getByRole("tree", { name: "Files in your workspace" })
    .getByRole("treeitem", { name: fileName, exact: true });
  await expect(fileRow).toHaveCount(1, { timeout: 30_000 });

  for (const theme of ["light", "dark"] as const) {
    if (theme === "dark") {
      await themeToggle(page).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    }
    await chat.openThreads();
    await checkRowMenu(page, threadRow, `Actions for ${title}`, THREAD_ITEMS, theme);
    await chat.closeThreads();
    await checkRowMenu(page, fileRow, `Actions for ${fileName}`, FILE_ITEMS, theme);
  }

  // Copy: the conversation on screen as Markdown.
  await chat.openThreads();
  await threadRow.hover();
  await threadRow.getByRole("button", { name: `Actions for ${title}` }).click();
  await page.getByRole("menuitem", { name: "Copy", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toMatch(new RegExp(`^# ${title}\\n[\\s\\S]*## You[\\s\\S]*## Assistant[\\s\\S]*OK`));

  // Clean up the file through its menu (Delete asks first).
  await chat.closeThreads();
  await fileRow.hover();
  await fileRow.getByRole("button", { name: `Actions for ${fileName}` }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  const confirm = files.getByRole("alertdialog");
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(fileRow).toHaveCount(0, { timeout: 30_000 });

  // Back to light for the next spec's assumptions.
  await themeToggle(page).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});
