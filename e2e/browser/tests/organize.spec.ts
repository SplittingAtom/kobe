import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./support/chat.js";
import { expectThemed, paintOf } from "./support/colours.js";

/**
 * KOBE-220 (CE19): Pin, Archive and Move to project from a thread row's ⋯ menu. The rail's groups
 * follow at once and after a reload (ac-1); a move lands under the project and the next run shows
 * the "Moved to project" marker (ac-2); an archived thread is still found by search, marked
 * (ac-3). The project is made (and archived afterwards) through the API, so the member needs to be
 * allowed to create projects (a team admin or builder, as for the theme spec's admin console).
 */
const TEAM_KEY = "kobe.lastTeamId";
const THEME_COOKIE = "kobe-theme";

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

/** A group of the Threads panel (KOBE-453: the threads left the rail for it). */
const threads = (page: Page) => page.getByRole("dialog", { name: "Threads" });
const group = (page: Page, kind: string) => threads(page).locator(`[data-group="${kind}"]`);

/**
 * Chooses a node of the panel's folder tree (KOBE-536): Archived sits under Current, shown by
 * Current's chevron; each node's list replaces the panel's groups.
 */
async function chooseNode(page: Page, name: "Current" | "Archived") {
  const tree = threads(page).getByRole("tree", { name: "Thread folders" });
  const node = tree.getByRole("treeitem", { name, exact: true });
  if (name === "Archived" && (await node.count()) === 0) {
    await tree
      .getByRole("treeitem", { name: "Current", exact: true })
      .locator("button")
      .first()
      .click();
  }
  await node.click();
  await expect(node).toHaveAttribute("aria-selected", "true");
}

async function menuChoice(page: Page, row: Locator, title: string, item: string) {
  await row.hover();
  await row.getByRole("button", { name: `Actions for ${title}`, exact: true }).click();
  const menu = page.getByRole("menu", { name: `Actions for ${title}`, exact: true });
  await menu.getByRole("menuitem", { name: item, exact: true }).click();
  await expect(menu).toBeHidden();
}

test("pin, archive and move to project, in the Threads panel and after a reload", async ({
  chat,
  page,
  context,
}) => {
  await context.clearCookies({ name: THEME_COOKIE });
  const suffix = Date.now().toString(36);
  const title = `Organize ${suffix}`;
  const projectName = `KOBE-220 ${suffix}`;

  await chat.open();
  await chat.ask("No tools. Reply with the single word OK.");
  const header = page.locator("header").filter({ has: page.locator("#kobe-thread-title") });
  await header.getByRole("button", { name: /^Rename / }).click();
  const name = page.getByRole("textbox", { name: "Conversation name", exact: true });
  await name.fill(title);
  await name.press("Enter");
  await chat.openThreads();
  const rowIn = (kind: string) =>
    group(page, kind).locator("[data-kobe-thread]").filter({ hasText: title });
  await expect(rowIn("ungrouped")).toHaveCount(1);

  // ac-1: Pin → the Pinned group at the top, kept after a reload; Unpin puts it back.
  await menuChoice(page, rowIn("ungrouped"), title, "Pin");
  await expect(rowIn("pinned")).toHaveCount(1);
  await expect(threads(page).locator("[data-group]").first()).toHaveAttribute(
    "data-group",
    "pinned",
  );
  // The panel's address reloads with it open.
  await page.reload();
  await chat.openThreads();
  await expect(rowIn("pinned")).toHaveCount(1);
  await menuChoice(page, rowIn("pinned"), title, "Unpin");
  await expect(rowIn("ungrouped")).toHaveCount(1);

  // ac-1, ac-3: Archive → the tree's Archived node (folded under Current, KOBE-536), after a
  // reload too; search marks it.
  await menuChoice(page, rowIn("ungrouped"), title, "Archive");
  await expect(rowIn("ungrouped")).toHaveCount(0);
  const archivedRow = threads(page)
    .getByRole("list", { name: "Archived", exact: true })
    .locator("[data-kobe-thread]")
    .filter({ hasText: title });
  await page.reload();
  await chat.openThreads();
  await chooseNode(page, "Archived");
  await expect(archivedRow).toHaveCount(1);
  // The bar's search is behind the panel: closed first.
  await chat.closeThreads();
  const search = page.getByRole("searchbox", { name: "Search conversations" });
  await search.fill(`"${title}"`);
  await search.press("Enter");
  const hits = page.getByRole("list", { name: "Search results" });
  const hit = hits.getByRole("listitem").filter({ hasText: title });
  await expect(hit).toHaveCount(1);
  await expect(hit.locator("[data-kobe-archived]")).toHaveText("Archived");
  await search.press("Escape");
  // The panel reopens on the node last chosen in this tab (Archived).
  await chat.openThreads();
  await chooseNode(page, "Archived");
  await menuChoice(page, archivedRow, title, "Unarchive");
  await expect(archivedRow).toHaveCount(0);
  await chooseNode(page, "Current");
  await expect(rowIn("ungrouped")).toHaveCount(1);

  // ac-2: Move to project → under the project's header; the next run is marked.
  const made = await api(page, "POST", "/v1/projects", { name: projectName });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const projectId = (made.json as { id: string }).id;
  try {
    await page.reload();
    await chat.openThreads();
    const row = rowIn("ungrouped");
    await row.hover();
    await row.getByRole("button", { name: `Actions for ${title}`, exact: true }).click();
    const menu = page.getByRole("menu", { name: `Actions for ${title}`, exact: true });
    const move = menu.getByRole("menuitem", { name: "Move to project", exact: true });
    await expect(move).not.toHaveAttribute("aria-disabled", "true");
    await move.focus();
    await page.keyboard.press("ArrowRight");
    const projects = page.getByRole("menu", { name: "Move to project", exact: true });
    expectThemed("Move to project menu", await paintOf(projects), "light");
    await projects.getByRole("menuitem", { name: projectName, exact: true }).click();
    const projectGroup = threads(page)
      .locator('[data-group="project"]')
      .filter({ has: page.getByRole("button", { name: new RegExp(projectName) }) });
    await expect(projectGroup.locator("[data-kobe-thread]").filter({ hasText: title })).toHaveCount(
      1,
    );
    await page.reload();
    await chat.openThreads();
    await expect(projectGroup.locator("[data-kobe-thread]").filter({ hasText: title })).toHaveCount(
      1,
    );

    await chat.closeThreads();
    await chat.ask("No tools. Reply with the single word MOVED.");
    const marker = page.locator('[data-kobe-marker="project"]');
    await expect(marker).toHaveCount(1);
    await expect(marker).toContainText(`Moved to project ${projectName}`);

    // Both themes: the marker stays readable in dark.
    await page.getByRole("button", { name: "Dark theme", exact: true }).first().click();
    await expect(marker).toBeVisible();
  } finally {
    // The thread goes to Trash (fixture); the project is archived (threads keep it from deletion).
    await api(page, "PATCH", `/v1/projects/${projectId}`, { archived: true });
    await context.clearCookies({ name: THEME_COOKIE });
  }
});
