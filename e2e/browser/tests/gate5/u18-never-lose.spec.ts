import { RUN_START_TIMEOUT_MS, RUN_TIMEOUT_MS, SHELL_TIMEOUT_MS } from "../support/constants.js";
import { expect, test } from "../support/chat.js";
import {
  deleteWorkspacePath,
  longAnswer,
  regions,
  toolTurn,
  widthOf,
  workspaceFile,
} from "../support/gate5.js";

/**
 * Gate 5, U18 (KOBE-227): "Artifacts, files, memory, settings open beside the thread; scrolling up
 * mid-stream holds the view and the Jump pill counts new messages; the composer is visible at
 * every width." The hold and re-pin are scroll-follow.spec.ts; these are the rest.
 */
const WIDTHS = [1920, 1280, 960, 800, 390] as const;

test("U18: an artifact and a workspace file open beside the thread", async ({ chat, page }) => {
  const { artifact, conversation } = regions(page);
  const dir = `g5-${Date.now().toString(36)}`;
  await chat.open();
  try {
    await chat.send(
      toolTurn("create_artifact", {
        kind: "html",
        title: `${dir} beside`,
        content: "<!doctype html><html><body><p>beside</p></body></html>",
      }),
    );
    await chat.threadId(); // create_artifact never asks (PROMPT_EXEMPT_KOBE_TOOLS)
    await chat.waitForIdle();
    await expect(artifact.getByRole("tab").first()).toBeVisible({ timeout: RUN_TIMEOUT_MS });
    await expect(chat.composer).toBeInViewport();
    expect(await widthOf(conversation)).toBeGreaterThanOrEqual(399);

    expect(await workspaceFile(page, `${dir}/notes.txt`, "notes beside the thread\n")).toBe(201);
    const files = page.getByRole("region", { name: "Files" });
    const openFiles = files.getByRole("button", { name: "Open files" });
    if (await openFiles.isVisible()) await openFiles.click();
    await files.getByRole("button", { name: "Refresh files" }).click();
    const tree = files.getByRole("tree", { name: "Files in your workspace" });
    await tree.getByRole("treeitem", { name: dir, exact: true }).click();
    await tree.getByRole("treeitem", { name: "notes.txt", exact: true }).click();
    await expect(artifact.getByRole("tab", { name: /notes\.txt/ })).toBeVisible();
    await expect(chat.composer).toBeInViewport();
    await expect(chat.answers.last()).toBeInViewport();
  } finally {
    await deleteWorkspacePath(page, dir);
  }
});

test("U18: memory and the member's settings open beside the thread (CE4)", async ({
  chat,
  page,
}) => {
  // KOBE-424: My memory, My approvals (and My schedules, My connectors) open in the artifact
  // column; the thread, its answer and the composer stay on screen.
  const { artifact } = regions(page);
  await chat.open();
  await chat.ask("No tools. Reply with the single word MEMORY.");
  const thread = await chat.threadId();
  await page.locator('[data-command="my-memory"]').click();
  await expect(artifact.getByRole("region", { name: "My memory" })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await expect(chat.composer).toBeInViewport();
  await expect(chat.answers.last()).toBeInViewport();
  expect(new URL(page.url()).searchParams.get("thread")).toBe(thread);
  expect(new URL(page.url()).searchParams.get("area")).toBe("memory");
  await page.locator('[data-command="profile"]').click();
  await page.getByRole("link", { name: "My approvals" }).click();
  await expect(artifact.getByRole("region", { name: "My approvals" })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await expect(chat.composer).toBeInViewport();
  expect(new URL(page.url()).searchParams.get("thread")).toBe(thread);
  await expect(artifact.getByRole("heading", { name: "Remembered approvals" })).toBeVisible();
  // One page replaces the other: Back returns to the thread alone, and Forward reopens it.
  await page.goBack();
  await expect(page.locator("[data-kobe-area]")).toHaveCount(0);
  await expect(chat.composer).toBeVisible();
  await page.goForward();
  await expect(artifact.getByRole("region", { name: "My approvals" })).toBeVisible();
});

test("U18: while scrolled up, the Jump pill counts the messages that arrive", async ({
  chat,
  page,
}) => {
  // The messages arrive in this tab's own stream: a long answer, and a message queued behind it
  // (Enter while it works, CE10) that runs once it ends. An open thread does not follow runs
  // another tab or device starts (it reads them when opened again), so they are not the source.
  await chat.open();
  await chat.ask("No tools. Reply with the single word FIRST.");
  await chat.send(longAnswer("No tools. Write a numbered list of 80 short lines about fruit."));
  await expect(chat.steering).toHaveAttribute("data-state", "active", {
    timeout: RUN_START_TIMEOUT_MS,
  });
  await chat.send("No tools. Reply with the single word ARRIVED.");
  // Scrolled up mid-stream: the list is unpinned and holds.
  const list = chat.list;
  const box = await list.boundingBox();
  if (box === null) throw new Error("the message list has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let step = 0; step < 6; step += 1) await page.mouse.wheel(0, -200);
  await expect(list).toHaveAttribute("data-kobe-follow", "unpinned");
  const jump = page.getByRole("button", { name: /^Jump to latest/ });
  await expect(jump).toBeVisible();
  // The queued message and its answer arrive after the long answer: two new messages.
  await expect(page.getByText("ARRIVED").first()).toBeAttached({ timeout: 2 * RUN_TIMEOUT_MS });
  await expect(jump).toHaveAccessibleName(/\b2 new messages\b/, { timeout: RUN_TIMEOUT_MS });
  await expect(list).toHaveAttribute("data-kobe-follow", "unpinned");
});

test("U18: the composer is visible at every width", async ({ chat, page }) => {
  await chat.open();
  await chat.ask("No tools. Reply with the single word WIDTH.");
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
    await expect(chat.composer).toBeInViewport();
    const overflow = await page.evaluate(() => {
      const root = document.scrollingElement ?? document.documentElement;
      return root.scrollHeight - root.clientHeight;
    });
    expect(overflow, `page scroll at ${width} px`).toBeLessThanOrEqual(1);
  }
});
