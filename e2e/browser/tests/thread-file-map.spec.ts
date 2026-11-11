import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./support/chat.js";
import { RUN_TIMEOUT_MS, SHELL_TIMEOUT_MS } from "./support/constants.js";
import {
  deleteWorkspacePath,
  pageApi,
  secondBrowser,
  toolTurn,
  workspaceFile,
} from "./support/gate5.js";

/**
 * KOBE-613 (TFM-4, spec docs/specs/thread-file-map.md): the Threads panel's thread–file lines.
 *
 * Owner (KOBE_USER): a thread whose agent reads one file of a new `kobe-613-*` folder and writes
 * another (two short turns, the `read` and `write` tools; with KOBE_FAKE_MODEL=1 the fake's
 * `tool:` lines). At 1,280 px the panel has three rails: hovering the thread row draws a solid line
 * to the written file and a dashed one to the read file (TFM1); its pin keeps them after the
 * pointer leaves (TFM5); hovering the written file in the workspace rail draws a line to the
 * thread. At 900 px there is no workspace rail and no lines, the row shows "Files (N)" (TFM4).
 *
 * Shared (KOBE_USER2 / KOBE_PW2, skipped without them): the owner's thread in a new project reads
 * the project's file and writes one in the owner's own workspace, and is shared with the team.
 * member2 sees the project file by name and the owner's file only as a count (TFM7).
 *
 * Links come from the server's policy decision on the agent's tool calls (KOBE-610); each test
 * waits for them through `GET /v1/threads/{id}/file-links` before opening the panel, because the
 * panel reads a row's links once. Clean-up (finally) deletes the folders, unshares, archives and
 * deletes the project; the `chat` fixture trashes the threads.
 */
const SECOND_USER = process.env["KOBE_USER2"];
const SECOND_PW = process.env["KOBE_PW2"];
const NARROW = { width: 900, height: 800 };

interface LinkedFile {
  readonly path: string;
  readonly access: "read" | "write";
  readonly deleted: boolean;
}
interface ThreadLinks {
  readonly files?: LinkedFile[];
  readonly hidden_count?: number;
}

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** One thread's links as the viewer may see them (`GET /v1/threads/{id}/file-links`). */
async function linksOf(page: Page, threadId: string): Promise<ThreadLinks> {
  const res = await pageApi<ThreadLinks>(page, "GET", `/v1/threads/${threadId}/file-links`);
  return res.status === 200 ? res.json : {};
}

/** Waits until the thread links `path` live (not deleted: the sandbox pushed it) with `access`. */
async function waitForLink(page: Page, threadId: string, path: string, access: "read" | "write") {
  await expect
    .poll(
      async () =>
        (await linksOf(page, threadId)).files?.some(
          (f) => f.path === path && f.access === access && !f.deleted,
        ) ?? false,
      { timeout: RUN_TIMEOUT_MS, intervals: [2_000] },
    )
    .toBe(true);
}

/** Renames the open conversation from its header. */
async function rename(page: Page, title: string): Promise<void> {
  const header = page.locator("header").filter({ has: page.locator("#kobe-thread-title") });
  await header.getByRole("button", { name: /^Rename / }).click();
  const name = page.getByRole("textbox", { name: "Conversation name", exact: true });
  await name.fill(title);
  await name.press("Enter");
}

const panelOf = (page: Page) => page.getByRole("dialog", { name: "Threads" });
const bodyOf = (page: Page) => panelOf(page).locator("[data-kobe-threads-body]");
const rowOf = (page: Page, threadId: string) =>
  panelOf(page).locator(`[data-kobe-thread="${threadId}"]`);
const railOf = (page: Page) => panelOf(page).locator("[data-kobe-file-rail]");
const railRow = (page: Page, path: string) =>
  railOf(page).locator(`[role="treeitem"][data-path="${path}"]`);
const lines = (page: Page) => panelOf(page).locator("[data-kobe-file-lines] [data-kobe-line]");
const lineTo = (page: Page, anchor: string) =>
  panelOf(page).locator(`[data-kobe-file-lines] [data-kobe-line="${anchor}"]`);
const filesButton = (row: Locator) => row.getByRole("button", { name: /^Files \(\d+\)$/ });

/** Moves the pointer off the panel's rails (the search box): hover lines go. */
async function pointAway(page: Page): Promise<void> {
  await panelOf(page).getByRole("searchbox", { name: "Search threads" }).hover();
  // A focused row shows its lines too (TFM5), and opening a rail folder leaves focus on it.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** Opens the folder `dir` in the workspace rail (a click on a folder row folds it, opens nothing). */
async function openRailFolder(page: Page, dir: string): Promise<void> {
  const folder = railRow(page, dir);
  await expect(folder).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  if ((await folder.getAttribute("aria-expanded")) !== "true") await folder.click();
  await expect(folder).toHaveAttribute("aria-expanded", "true");
}

test("hover a thread: solid line to the written file, dashed to the read one; pin; hover the file; narrow lists", async ({
  chat,
  page,
}) => {
  const dir = `kobe-613-${uniq()}`;
  const readPath = `${dir}/source.txt`;
  const writePath = `${dir}/written.txt`;
  const title = `File map ${dir}`;
  await chat.open();
  expect(await workspaceFile(page, readPath, "source for the thread-file map\n")).toBe(201);
  try {
    const threadId = await chat.ask(toolTurn("read", { path: `/workspace/${readPath}` }));
    await chat.ask(
      toolTurn("write", { path: `/workspace/${writePath}`, content: "written by the agent\n" }),
    );
    await rename(page, title);
    await waitForLink(page, threadId, readPath, "read");
    await waitForLink(page, threadId, writePath, "write");
    const known = await linksOf(page, threadId);
    const count = (known.files?.length ?? 0) + (known.hidden_count ?? 0);

    // A fresh panel: its rows' links and its workspace tree are read when it opens.
    await page.reload();
    await chat.openThreads();
    await expect(bodyOf(page)).toHaveAttribute("data-kobe-threads-body", "three-rails");
    const row = rowOf(page, threadId);
    await expect(row).toHaveCount(1, { timeout: SHELL_TIMEOUT_MS });
    await expect(filesButton(row)).toHaveText(`Files (${count})`, { timeout: SHELL_TIMEOUT_MS });
    await openRailFolder(page, dir);
    await railRow(page, writePath).scrollIntoViewIfNeeded();
    await expect(railRow(page, readPath)).toBeVisible();

    // Hover the thread (TFM1): written solid, read dashed.
    await row.hover();
    await expect(lineTo(page, writePath)).toHaveAttribute("data-access", "write");
    await expect(lineTo(page, readPath)).toHaveAttribute("data-access", "read");
    await expect(lineTo(page, writePath).locator("path")).not.toHaveAttribute(
      "stroke-dasharray",
      /.+/,
    );
    await expect(lineTo(page, readPath).locator("path")).toHaveAttribute("stroke-dasharray", /\d/);
    await test.info().attach("thread-file-map-hover.png", {
      body: await panelOf(page).screenshot({ animations: "disabled" }),
      contentType: "image/png",
    });

    // Without the pointer the lines go; the pin keeps them (TFM5).
    await pointAway(page);
    await expect(lines(page)).toHaveCount(0);
    await row.hover();
    const pin = row.getByRole("button", { name: /^Keep lines shown for / });
    await pin.click();
    await expect(pin).toHaveAttribute("aria-pressed", "true");
    await pointAway(page);
    await page.waitForTimeout(500);
    await expect(lineTo(page, writePath)).toHaveCount(1);
    await expect(lineTo(page, readPath)).toHaveCount(1);
    await pin.click();
    await expect(pin).toHaveAttribute("aria-pressed", "false");
    await pointAway(page);
    await expect(lines(page)).toHaveCount(0);

    // Hover the written file in the workspace rail: a line to the thread.
    await railRow(page, writePath).hover();
    await expect(lineTo(page, threadId)).toHaveCount(1);
    await expect(lineTo(page, threadId)).toHaveAttribute("data-access", "write");
    await pointAway(page);
    await expect(lines(page)).toHaveCount(0);

    // The list way to the same links: "Files (N)" opens the files as links.
    await filesButton(row).click();
    const list = row.getByRole("list", { name: `Files ${title} used` });
    await expect(list.getByRole("button", { name: "written.txt", exact: true })).toBeVisible();
    await expect(list.getByRole("button", { name: "source.txt", exact: true })).toBeVisible();
    await expect(list).toContainText("written");
    await expect(list).toContainText("read");

    // Narrow (TFM4): no workspace rail and no lines, the row still says "Files (N)".
    await page.setViewportSize(NARROW);
    await chat.openThreads();
    await expect(bodyOf(page)).not.toHaveAttribute("data-kobe-threads-body", "three-rails");
    await expect(railOf(page)).toHaveCount(0);
    const narrowRow = rowOf(page, threadId);
    await expect(narrowRow).toHaveCount(1, { timeout: SHELL_TIMEOUT_MS });
    await narrowRow.hover();
    await expect(filesButton(narrowRow)).toHaveText(`Files (${count})`);
    await expect(narrowRow.getByRole("button", { name: /^Keep lines shown for / })).toHaveCount(0);
    await page.waitForTimeout(500);
    await expect(panelOf(page).locator("[data-kobe-file-lines]")).toHaveCount(0);
  } finally {
    await deleteWorkspacePath(page, dir);
  }
});

test("a shared thread shows the reader project files by name, the owner's own files as a count", async ({
  chat,
  page,
  browser,
}) => {
  test.skip(!SECOND_USER || !SECOND_PW, "KOBE_USER2 and KOBE_PW2 name a second member");
  const stem = `kobe-613-${uniq()}`;
  const ownPath = `${stem}/own.txt`;
  const projectFile = "notes.md";
  await chat.open();
  const made = await pageApi<{ id: string; slug: string }>(page, "POST", "/v1/projects", {
    name: stem,
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const project = made.json;
  const projectPath = `projects/${project.slug}/${projectFile}`;
  let threadId: string | null = null;
  let second: Page | null = null;
  try {
    const uploaded = await page.evaluate(
      async ({ id, name }) => {
        const team = window.localStorage.getItem("kobe.lastTeamId");
        const form = new FormData();
        form.set("file", new File(["project notes\n"], name, { type: "text/markdown" }));
        const res = await fetch(`/v1/projects/${id}/files`, {
          method: "POST",
          headers: team ? { "x-kobe-team": team } : {},
          body: form,
        });
        return res.status;
      },
      { id: project.id, name: projectFile },
    );
    expect(uploaded).toBe(201);

    // A conversation in the project: the agent reads the project's file, writes one of its own.
    await page.goto(`/?project=${project.id}`);
    await expect(chat.composer).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    threadId = await chat.ask(toolTurn("read", { path: `/workspace/${projectPath}` }));
    await chat.ask(toolTurn("write", { path: `/workspace/${ownPath}`, content: "owner only\n" }));
    await waitForLink(page, threadId, projectPath, "read");
    await waitForLink(page, threadId, ownPath, "write");
    const shared = await pageApi(page, "POST", `/v1/threads/${threadId}/share`, {
      visibility: "team",
    });
    expect(shared.status, JSON.stringify(shared.json)).toBeLessThan(300);

    second = await secondBrowser(browser, SECOND_USER, SECOND_PW);
    // The server's answer to member2: the project file by name, the owner's file counted.
    const theirs = await linksOf(second, threadId);
    expect((theirs.files ?? []).map((f) => f.path)).toContain(projectPath);
    expect((theirs.files ?? []).map((f) => f.path)).not.toContain(ownPath);
    expect(theirs.hidden_count ?? 0).toBeGreaterThanOrEqual(1);
    const count = (theirs.files?.length ?? 0) + (theirs.hidden_count ?? 0);

    await second.goto("/threads");
    await expect(panelOf(second)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    const current = panelOf(second)
      .getByRole("tree", { name: "Thread folders" })
      .getByRole("treeitem", { name: "Current", exact: true });
    await current.click();
    const row = rowOf(second, threadId);
    await expect(row).toHaveCount(1, { timeout: SHELL_TIMEOUT_MS });
    await expect(filesButton(row)).toHaveText(`Files (${count})`, { timeout: SHELL_TIMEOUT_MS });
    await filesButton(row).click();
    const list = row.getByRole("list", { name: /^Files .* used$/ });
    await expect(list.getByRole("button", { name: projectFile, exact: true })).toHaveAttribute(
      "title",
      projectPath,
    );
    await expect(list).toContainText(/\d+ files? you can't see/);
    await expect(list).not.toContainText("own.txt");

    // Hovering it never draws a line to the owner's file.
    await row.hover();
    await second.waitForTimeout(500);
    await expect(lineTo(second, ownPath)).toHaveCount(0);
  } finally {
    if (threadId) {
      await pageApi(page, "POST", `/v1/threads/${threadId}/share`, { visibility: "private" }).catch(
        (e: unknown) => console.warn(`could not unshare ${threadId} (${String(e)})`),
      );
    }
    await deleteWorkspacePath(page, stem).catch((e: unknown) =>
      console.warn(`could not delete ${stem} (${String(e)})`),
    );
    await pageApi(page, "PATCH", `/v1/projects/${project.id}`, { archived: true });
    await pageApi(page, "DELETE", `/v1/projects/${project.id}`);
    await second?.context().close();
  }
});
