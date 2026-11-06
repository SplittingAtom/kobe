import { readFile, rm } from "node:fs/promises";
import type { Locator, Page } from "@playwright/test";
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
  openTree,
  promptRow,
  removeLabel,
  rowMenu,
  showFromTree,
  treePanel,
} from "./support/tree.js";
import { ZipFile } from "./support/zip.js";

/**
 * KOBE-549 (CT-8): the conversation tree in a real browser, part 2, on its own branched thread
 * (support/tree.ts): the tree at phone width (CT18), Compare versions (CT10, KOBE-547), every
 * branch in the export zip with the labels (CT14), and Make it current with a carried summary
 * (CT11, KOBE-548). Compare and the summary skip themselves, with a note, on a deployment that
 * does not offer them yet. The summary test runs last: it moves the leaf for good. The thread
 * goes to Trash at the end, and the downloaded zip is deleted.
 */
test.describe.configure({ mode: "serial" });

let page: Page;
let chat: Chat;
let thread: Branched | undefined;

const mustThread = (): Branched => {
  if (!thread) throw new Error("the branched thread was not built (beforeAll failed)");
  return thread;
};

const WIDE = { width: 1280, height: 800 } as const;
const PHONE = { width: 390, height: 844 } as const;
const EXPORT_TIMEOUT_MS = 180_000;
const NOT_OFFERED_MS = 5_000;

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext({ storageState: STORAGE_STATE })).newPage();
  chat = new Chat(page);
  thread = await buildBranchedThread(chat);
});

test.afterAll(async () => {
  await chat.trashAll();
  await page.context().close();
});

/** Waits a moment for an optional control; false when the deployment does not show it. */
async function offered(control: Locator): Promise<boolean> {
  return control
    .first()
    .waitFor({ timeout: NOT_OFFERED_MS })
    .then(
      () => true,
      () => false,
    );
}

test("the tree at phone width: a list by junction with the chips and a working row menu", async () => {
  const { token } = mustThread();
  await page.setViewportSize(PHONE);
  try {
    const panel = await openTree(page);
    await expect(panel.locator('[data-kobe-tree-panel="list"]')).toBeVisible();
    // One junction (under the first answer), headed by it, with both branches as rows.
    const section = panel.getByRole("region", { name: /^Branches after: / });
    await expect(section).toHaveCount(1);
    const rows = section.getByRole("listitem");
    await expect(rows).toHaveCount(2);
    const side = rows.filter({ hasText: token });
    const main = rows.filter({ hasText: `Branch ${MAIN}` });
    await expect(main).toContainText("◀ on screen");
    await expect(main).toContainText("leaf");
    await expect(side).not.toContainText("◀ on screen");
    await test.info().attach("conversation-tree-phone.png", {
      body: await panel.screenshot({ animations: "disabled" }),
      contentType: "image/png",
    });

    // The row's ⋯ holds the node menu; Show in conversation opens that branch (head only).
    const menu = await rowMenu(page, side);
    await expect(
      menu.getByRole("menuitem", { name: "Make it current", exact: true }),
    ).toBeVisible();
    await menu.getByRole("menuitem", { name: "Show in conversation", exact: true }).click();
    await expect(treePanel(page)).toBeHidden();
    await expectBrowsing(page, token);
    await backToLeaf(page);
  } finally {
    await closeTree(page);
    await page.setViewportSize(WIDE);
  }
});

test("Compare versions from the picker: two columns, Show this version moves only the view", async () => {
  const { token } = mustThread();
  const picker = forkMarker(page);
  await expect(picker).toContainText("Version 2 of 2");
  const compare = picker.getByRole("button", { name: "Compare versions", exact: true });
  test.skip(!(await offered(compare)), "no Compare icon: KOBE-547 is not deployed here yet");
  await compare.click();

  const dialog = page.getByRole("dialog", { name: "Compare versions" });
  await expect(dialog).toBeVisible();
  const first = dialog.getByRole("region", { name: /^Version 1\b/ });
  const second = dialog.getByRole("region", { name: /^Version 2\b/ });
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  // The prompts differ, so each column shows its own prompt above the answer.
  await expect(first).toContainText(token);
  await expect(second).toContainText(`Branch ${MAIN}`);

  await first.getByRole("button", { name: "Show this version", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expectBrowsing(page, token);
  await backToLeaf(page);
  await expectLeafAfterReload(page, MAIN);
});

test("export: the zip has a file for the inactive branch and the thread's labels", async () => {
  const { threadId, token } = mustThread();
  await labelPrompt(page, token, LABEL);
  await closeTree(page);
  const file = test.info().outputPath("kobe-549-export.zip");
  try {
    const panel = await chat.openThreads();
    const link = panel.getByRole("link", { name: "Export my conversations", exact: true });
    const downloading = page.waitForEvent("download", { timeout: EXPORT_TIMEOUT_MS });
    await link.click();
    const download = await downloading;
    await download.saveAs(file);
    expect(await download.failure()).toBeNull();
    await chat.closeThreads();

    const zip = new ZipFile(await readFile(file));
    const index = JSON.parse(zip.text("threads.json")) as {
      threads: {
        id: string;
        transcript?: string;
        labels?: { entry_id: string; label: string }[];
        branches?: string[];
      }[];
    };
    const entry = index.threads.find((t) => t.id === threadId);
    expect(entry, "the thread is in threads.json").toBeDefined();
    // CT9: the labels in the thread's metadata.
    expect(entry?.labels?.map((l) => l.label)).toEqual([LABEL]);
    // CT14: one branch file for the inactive leaf, in the zip, beside the leaf's transcript.
    const branches = entry?.branches ?? [];
    expect(branches).toHaveLength(1);
    const name = branches[0] as string;
    expect(name).toMatch(/^branches\/[^/]+\/1-[^/]+\.md$/);
    expect(zip.names).toContain(name);
    const branch = zip.text(name);
    expect(branch).toMatch(/Branched from message \d+ of the main transcript: “/);
    expect(branch).toContain(token);
    expect(branch).not.toContain(`Branch ${MAIN}`);
    if (entry?.transcript) expect(zip.text(entry.transcript)).toContain(`Branch ${MAIN}`);
  } finally {
    // The zip holds the member's conversations: never left in test-results.
    await rm(file, { force: true });
    await chat.closeThreads();
    await removeLabel(page, token, LABEL);
    await closeTree(page);
  }
});

/**
 * Finds "Make it current and carry a summary": in the bar's "Make it current ▾" menu, else in the
 * side prompt's node menu in the tree. Null when the deployment offers neither (KOBE-548).
 */
async function carrySummaryItem(token: string): Promise<Locator | null> {
  const name = /carry a summary/i;
  const more = branchBar(page).locator('button[aria-haspopup="menu"]');
  if (await offered(more)) {
    await more.first().click();
    const item = page.getByRole("menuitem", { name });
    if (await offered(item)) return item.first();
    await page.keyboard.press("Escape");
  }
  await openTree(page);
  const menu = await rowMenu(page, promptRow(page, token));
  const item = menu.getByRole("menuitem", { name });
  if (await offered(item)) return item.first();
  await page.keyboard.press("Escape");
  await closeTree(page);
  return null;
}

test("Make it current and carry a summary: the marker on the entered branch and in the tree", async () => {
  const { token } = mustThread();
  await showFromTree(page, token);
  await expectBrowsing(page, token);
  const item = await carrySummaryItem(token);
  if (item === null) {
    await backToLeaf(page);
    test.skip(true, "no Make it current and carry a summary: KOBE-548 is not deployed here yet");
    return;
  }
  await item.click();
  // A dialog like Compact now's: what will happen, an optional focus, Go.
  const dialog = page
    .getByRole("dialog")
    .filter({ hasText: /summar/i })
    .last();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Go", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await chat.waitForIdle();

  // The side branch is now the leaf's, with the summary of the branch left as its last entry.
  await expect(branchBar(page)).toHaveCount(0);
  await expect(lastPrompt(page)).toContainText(token);
  const marker = page.getByText("Summary of another branch");
  await expect(marker.first()).toBeVisible({ timeout: 30_000 });
  await expectLeafAfterReload(page, token);
  await expect(marker.first()).toBeVisible();
  // The tree shows it as the "summary carried" row under its node.
  const panel = await openTree(page);
  await expect(panel.getByText(/summary carried/)).toBeVisible();
  await closeTree(page);
});
