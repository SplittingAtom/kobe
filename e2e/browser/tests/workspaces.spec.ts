import type { Browser, Page } from "@playwright/test";
import { Chat, expect, filesSection, test } from "./support/chat.js";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";
import { pageApi, secondBrowser } from "./support/gate5.js";
import { panelOf } from "./support/panel.js";

/**
 * KOBE-582 (Workspaces WS-7, spec docs/specs/workspaces.md), updated by KOBE-587 (every workspace
 * member reads every project, projects-in-conversations RV1-RV3): the owner (KOBE_USER, Team1
 * admin) creates a project with one file and adds nobody; member2 (KOBE_USER2 / KOBE_PW2, a plain
 * member) is a reader by default. member2 converses in it: the Files panel lists the project under
 * Projects, read-only with "You can read this project, not change it.", and an upload is refused
 * (403). The owner promotes member2 to editor (PATCH adds the row); member2 checks the project out, edits the file in the
 * editor, saves and commits with a message. The owner sees the commit in the project's History
 * tab and the edit in their own mount after opening a conversation in the project. One short
 * model turn (member2's first message). afterEach archives and deletes the project and moves the
 * threads to Trash; the spec skips when the deployment has no commit API or no second member.
 */
const USER2 = process.env["KOBE_USER2"];
const PW2 = process.env["KOBE_PW2"];

const FILE = "notes.md";
const BASE = "alpha\nbeta\n";
const EDIT = "edited by member two";
const MESSAGE = "Add member two's line";

interface Created {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

let owner: Page | null = null;
let projectId: string | null = null;
let ownerThreads: string[] = [];
let cleanups: (() => Promise<unknown>)[] = [];

test.beforeEach(async ({ page }) => {
  cleanups = [];
  ownerThreads = [];
  projectId = null;
  owner = page;
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  const probe = await pageApi(page, "GET", "/v1/me/checkouts");
  test.skip(probe.status === 404, "this deployment has no project checkout API (KOBE-579)");
});

test.afterEach(async () => {
  for (const step of cleanups.reverse()) {
    await step().catch((e: unknown) => console.warn(`clean-up step failed: ${String(e)}`));
  }
  cleanups = [];
  if (owner) {
    for (const id of ownerThreads) await pageApi(owner, "DELETE", `/v1/threads/${id}`);
    if (projectId) {
      // A project with commits is archived (its history stays); the delete removes the rest.
      await pageApi(owner, "PATCH", `/v1/projects/${projectId}`, { archived: true });
      await pageApi(owner, "DELETE", `/v1/projects/${projectId}`);
    }
  }
  owner = null;
  projectId = null;
});

/** The Projects tree of a page's Files panel, refreshed. */
async function projectsTree(page: Page) {
  const files = filesSection(page);
  await files.getByRole("button", { name: "Refresh files" }).click({ timeout: SHELL_TIMEOUT_MS });
  return files.getByRole("tree", { name: "Projects" });
}

/** Opens the project's file from the Projects tree; returns its tab panel. */
async function openProjectFile(page: Page, project: Created) {
  const tree = await projectsTree(page);
  const project_ = tree.getByRole("treeitem", { name: project.name, exact: true });
  await expect(project_).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  if ((await project_.getAttribute("aria-expanded")) !== "true") await project_.click();
  await tree.getByRole("treeitem", { name: FILE, exact: true }).click({
    timeout: SHELL_TIMEOUT_MS,
  });
  return page
    .getByRole("tabpanel")
    .filter({ has: page.getByRole("heading", { name: FILE }) })
    .first();
}

async function memberId(page: Page, email: string): Promise<string> {
  const r = await pageApi<{ members: { userId: string; email: string }[] }>(
    page,
    "GET",
    "/v1/team/members",
  );
  const found = r.json.members.find((m) => m.email.toLowerCase() === email.toLowerCase());
  expect(found, `${email} is a member of the owner's workspace`).toBeDefined();
  return found?.userId ?? "";
}

async function uploadAs(page: Page, id: string, name: string, text: string) {
  return page.evaluate(
    async ({ id, name, text }) => {
      const team = window.localStorage.getItem("kobe.lastTeamId");
      const form = new FormData();
      form.set("file", new File([text], name, { type: "text/markdown" }));
      const res = await fetch(`/v1/projects/${id}/files`, {
        method: "POST",
        headers: team ? { "x-kobe-team": team } : {},
        body: form,
      });
      return res.status;
    },
    { id, name, text },
  );
}

async function signInMember(browser: Browser): Promise<Page> {
  const page = await secondBrowser(browser, USER2, PW2);
  cleanups.unshift(() => page.context().close());
  return page;
}

test("a reader converses and cannot upload; as editor they check out, edit, commit; the owner sees it", async ({
  browser,
  page,
}) => {
  test.skip(!USER2 || !PW2, "KOBE_USER2 and KOBE_PW2 name a second member");
  const stem = `kobe-582-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

  // The owner: a project with one file; member2 has no row, so is a reader by default (RV1).
  const created = await pageApi<Created>(page, "POST", "/v1/projects", {
    name: `KOBE-582 ${stem}`,
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  projectId = created.json.id;
  const project = created.json;
  expect(await uploadAs(page, project.id, FILE, BASE)).toBe(201);
  const userId = await memberId(page, USER2 ?? "");

  // member2 converses in the project: it is mounted, read-only, "You can read this project".
  const other = await signInMember(browser);
  const chat = new Chat(other);
  cleanups.push(() => chat.trashAll());
  await other.goto(`/?project=${project.id}`);
  await expect(chat.composer).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await chat.showBothPanels("files");
  await chat.ask("No tools. Reply with the single word MOUNTED.");
  const readerTab = await openProjectFile(other, project);
  const readerBar = other.getByRole("region", { name: `Project ${project.name}` });
  await expect(readerBar.getByText("You can read this project, not change it.")).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await expect(readerBar.getByRole("button", { name: "Check out to edit" })).toHaveCount(0);
  await expect(readerTab.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);

  // A reader cannot upload: the server answers 403 (the project is never hidden from a member).
  expect(await uploadAs(other, project.id, "extra.md", "no")).toBe(403);
  await other.goto(`/me/projects/${project.id}`);
  const readerPage = panelOf(other);
  await expect(readerPage.getByRole("tab", { name: "History", exact: true })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await expect(readerPage.getByRole("form", { name: "Add a file" })).toHaveCount(0);

  // The owner promotes member2 to editor.
  const promoted = await pageApi(page, "PATCH", `/v1/projects/${project.id}/members/${userId}`, {
    role: "editor",
  });
  expect(promoted.status, JSON.stringify(promoted.json)).toBe(200);

  // The editor now has the project page's Add a file form.
  await other.goto(`/me/projects/${project.id}`);
  await expect(panelOf(other).getByRole("form", { name: "Add a file" })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });

  // member2 checks the project out, edits the file in the editor, saves and commits.
  await other.goto(`/?project=${project.id}`);
  await expect(chat.composer).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await chat.showBothPanels("files");
  const tab = await openProjectFile(other, project);
  const bar = other.getByRole("region", { name: `Project ${project.name}` });
  await bar.getByRole("button", { name: "Check out to edit" }).click({
    timeout: SHELL_TIMEOUT_MS,
  });
  await expect(bar.getByText("editing")).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await tab.getByRole("button", { name: "Raw", exact: true }).click();
  const editor = other.getByLabel(`Edit ${FILE}`);
  await expect(editor).toBeVisible();
  await editor.click();
  await other.keyboard.press("ControlOrMeta+End");
  await other.keyboard.type(`${EDIT}\n`);
  await expect(tab.getByText("Unsaved changes.")).toBeVisible();
  await tab.getByRole("button", { name: "Save", exact: true }).click();
  await expect(tab.getByText("Saved.")).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await bar.getByRole("button", { name: "Commit…" }).click();
  const form = bar.locator("form");
  await form.getByLabel("What changed?").fill(MESSAGE);
  await form.getByRole("button", { name: "Commit", exact: true }).click();
  await expect(form.getByLabel("What changed?")).toHaveCount(0, { timeout: SHELL_TIMEOUT_MS });

  const history = await pageApi<{ commits: { seq: number; message: string }[] }>(
    page,
    "GET",
    `/v1/projects/${project.id}/commits`,
  );
  expect(history.json.commits.map((c) => c.message)).toContain(MESSAGE);

  // The owner sees the commit in History ...
  await page.goto(`/me/projects/${project.id}`);
  const panel = panelOf(page);
  await panel.getByRole("tab", { name: "History", exact: true }).click();
  await expect(panel.getByText(MESSAGE)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });

  // ... and the file in their own mount after opening a conversation in the project.
  const thread = await pageApi<{ thread_id: string }>(page, "POST", "/v1/threads", {
    project_id: project.id,
  });
  expect(thread.status, JSON.stringify(thread.json)).toBe(201);
  ownerThreads.push(thread.json.thread_id);
  await page.goto(`/?thread=${thread.json.thread_id}`);
  await new Chat(page).showBothPanels("files");
  const ownerTab = await openProjectFile(page, project);
  await expect(ownerTab.getByText(EDIT)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
});
