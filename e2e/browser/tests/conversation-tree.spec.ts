import type { Page } from "@playwright/test";
import { Chat, expect, test } from "./support/chat.js";
import { STORAGE_STATE } from "./support/constants.js";
import {
  backToLeaf,
  type Branched,
  branchBar,
  buildBranchedThread,
  closeTree,
  expectBrowsing,
  expectLeafAfterReload,
  forkMarker,
  LABEL,
  labelPrompt,
  lastPrompt,
  MAIN,
  makeCurrentFromBar,
  NO_SECOND,
  openAsSecond,
  openTree,
  promptRow,
  removeLabel,
  rowMenu,
  SECOND_PW,
  SECOND_USER,
  share,
  showFromTree,
} from "./support/tree.js";

/**
 * KOBE-549 (CT-8): the conversation tree in a real browser, part 1. One thread with two branches
 * under the first answer, made by Continue from here (support/tree.ts), shared by the tests in
 * order: the picker's versions, browsing as the owner (the bar, ✕, Make it current), a search hit
 * on the side branch, browsing as a reader of the shared thread (KOBE_USER2/KOBE_PW2, skipped
 * without them), and labels. Each test leaves the leaf on the CHARLIE branch; the thread is
 * unshared and goes to Trash at the end. Part 2: conversation-tree-views.spec.ts.
 */
test.describe.configure({ mode: "serial" });

let page: Page;
let chat: Chat;
let thread: Branched | undefined;

const mustThread = (): Branched => {
  if (!thread) throw new Error("the branched thread was not built (first test failed)");
  return thread;
};

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext({ storageState: STORAGE_STATE })).newPage();
  chat = new Chat(page);
});

test.afterAll(async () => {
  if (thread && SECOND_USER) {
    await share(page, thread.threadId, "private").catch((e: unknown) =>
      console.warn(`could not unshare ${thread?.threadId} (${String(e)})`),
    );
  }
  await chat.trashAll();
  await page.context().close();
});

test("Continue from here on an answer branches the next prompt; the picker shows two versions", async () => {
  thread = await buildBranchedThread(chat);
  // The leaf's branch on screen: the first prompt, then the new one in place of the second.
  await expect(chat.userMessages).toHaveCount(2);
  await expect(chat.userMessages.first()).toContainText("ALPHA");
  await expect(lastPrompt(page)).toContainText(MAIN);
  await expect(forkMarker(page)).toContainText("Version 2 of 2");
  await expect(forkMarker(page)).toContainText("Forked here · 2 branches");
});

test("browse another branch as the owner: the bar, ✕, and Make it current moves the leaf", async () => {
  const { token } = mustThread();
  // The tree: a click on the side prompt shows its branch through the head; nothing is written.
  await showFromTree(page, token);
  await expectBrowsing(page, token);
  await expect(branchBar(page)).toContainText(/\d+ messages? differs?/);
  // ✕ returns to the leaf's branch.
  await backToLeaf(page);
  await expectLeafAfterReload(page, MAIN);

  // Make it current: the bar goes, and a reload (which starts at the leaf) shows that branch.
  await showFromTree(page, token);
  await expectBrowsing(page, token);
  await makeCurrentFromBar(page);
  await expect(lastPrompt(page)).toContainText(token);
  await expectLeafAfterReload(page, token);

  // Put the leaf back on the CHARLIE branch for the next tests (the same way).
  await showFromTree(page, MAIN);
  await expect(branchBar(page)).toBeVisible();
  await makeCurrentFromBar(page);
  await expectLeafAfterReload(page, MAIN);
});

test("a search hit on another branch opens that branch, scrolled to it, leaf untouched", async () => {
  const { threadId, token } = mustThread();
  // From a new draft, the bar's search finds the side prompt's word (indexing may lag a moment).
  await chat.open();
  const search = page.getByRole("searchbox", { name: "Search conversations" });
  const hits = page.getByRole("list", { name: "Search results" }).getByRole("listitem");
  await expect(async () => {
    await search.fill(token);
    await search.press("Enter");
    await expect(hits).toHaveCount(1, { timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  await hits.first().getByRole("button").first().click();

  // CT15: the thread opens on the hit's branch with the bar, the hit's message in view.
  await expect.poll(() => new URL(page.url()).searchParams.get("thread")).toBe(threadId);
  await expectBrowsing(page, token);
  await expect(page.locator('[data-role="user"]').filter({ hasText: token })).toBeInViewport();
  // The leaf is untouched: a reload shows the leaf's branch.
  await expectLeafAfterReload(page, MAIN);
});

test("a reader of the shared thread: the picker and the tree move only their view", async ({
  browser,
}) => {
  test.skip(!SECOND_USER || !SECOND_PW, NO_SECOND);
  const { threadId, token } = mustThread();
  await share(page, threadId, "team");
  const second = await openAsSecond(browser, threadId);
  try {
    // The picker's arrow shows the other version (head only: the leaf route is never called).
    const picker = forkMarker(second);
    await expect(picker).toContainText("Version 2 of 2");
    await picker.getByRole("button", { name: "Previous version", exact: true }).click();
    await expectBrowsing(second, token);
    await expect(picker).toContainText("Version 1 of 2");
    // No Make it current for a reader, and no error.
    await expect(
      branchBar(second).getByRole("button", { name: "Make it current", exact: true }),
    ).toHaveCount(0);
    await expect(second.locator("[data-kobe-thread-root]").getByRole("alert")).toHaveCount(0);

    // The tree: the CHARLIE row brings the leaf's branch back; the side row shows it again.
    await showFromTree(second, MAIN);
    await expect(branchBar(second)).toHaveCount(0);
    await showFromTree(second, token);
    await expectBrowsing(second, token);
    await backToLeaf(second);
  } finally {
    await second.context().close();
  }
  // The owner's leaf did not move.
  await expectLeafAfterReload(page, MAIN);
});

test("label a node: bold in the tree, in the picker, removed again; a reader sees it without Label…", async ({
  browser,
}) => {
  const { threadId, token } = mustThread();
  await labelPrompt(page, token, LABEL);
  // The tree shows it in bold before the excerpt.
  const shown = promptRow(page, token).getByText(LABEL, { exact: true });
  await expect(shown).toBeVisible();
  const weight = await shown.evaluate((el) => Number(getComputedStyle(el).fontWeight));
  expect(weight).toBeGreaterThanOrEqual(600);
  // The picker names the version on the branch's first message ("Version 1 of 2 · try 5% cut").
  await promptRow(page, token).click();
  await expectBrowsing(page, token);
  await expect(forkMarker(page)).toContainText(`Version 1 of 2 · ${LABEL}`);
  await backToLeaf(page);

  if (SECOND_USER && SECOND_PW) {
    await share(page, threadId, "team");
    const second = await openAsSecond(browser, threadId);
    try {
      await openTree(second);
      const row = promptRow(second, token);
      await expect(row).toHaveAttribute("aria-label", new RegExp(LABEL));
      const menu = await rowMenu(second, row);
      await expect(menu.getByRole("menuitem", { name: "Show in conversation" })).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: "Label…" })).toHaveCount(0);
      await expect(menu.getByRole("menuitem", { name: "Remove label" })).toHaveCount(0);
      await second.keyboard.press("Escape");
    } finally {
      await second.context().close();
    }
  } else {
    test.info().annotations.push({ type: "skipped-part", description: `reader: ${NO_SECOND}` });
  }

  // Remove label clears it from the tree.
  await removeLabel(page, token, LABEL);
  await expect(promptRow(page, token).getByText(LABEL, { exact: true })).toHaveCount(0);
  await closeTree(page);
});
