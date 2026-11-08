import type { Browser, Page } from "@playwright/test";
import { Chat, expect, filesSection, test } from "./support/chat.js";
import { RUN_TIMEOUT_MS, SHELL_TIMEOUT_MS } from "./support/constants.js";
import { pageApi, toolTurn } from "./support/gate5.js";

/**
 * KOBE-585 (workspaces lane WS-2): the owner asks the agent for a small markdown artifact and adds
 * it to a new project (members mode "team", so the second member belongs to it) with Add to
 * project on the artifact header. The second member signs in (KOBE_USER2 / KOBE_PW2, as the
 * KOBE-221 sharing spec), finds the file under projects/<slug>/ in Files, opens it read-only and
 * cannot save over it (403). afterEach archives the project. One short model turn.
 */
const SECOND_USER = process.env["KOBE_USER2"];
const SECOND_PW = process.env["KOBE_PW2"];

let owner: Page | null = null;
let projectId: string | null = null;

/** The second member, signed in in a fresh context (no saved session). */
async function signInSecond(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(SECOND_USER ?? "");
  await page.getByLabel("Password").fill(SECOND_PW ?? "");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), {
    timeout: SHELL_TIMEOUT_MS,
  });
  return page;
}

test.afterEach(async () => {
  if (owner && projectId) {
    await pageApi(owner, "PATCH", `/v1/projects/${projectId}`, { archived: true });
  }
  owner = null;
  projectId = null;
});

test("Add to project: the owner adds an artifact; another member reads it under projects/", async ({
  chat,
  page,
  browser,
}) => {
  test.skip(!SECOND_USER || !SECOND_PW, "KOBE_USER2 and KOBE_PW2 name a second member");
  const stem = `kobe-585-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await chat.open();
  owner = page;
  const created = await pageApi<{ id: string; slug: string; name: string }>(
    page,
    "POST",
    "/v1/projects",
    { name: `KOBE-585 ${stem}`, members_mode: "team" },
  );
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  projectId = created.json.id;
  const { slug, name: projectName } = created.json;

  await chat.send(
    toolTurn("create_artifact", {
      kind: "markdown",
      title: stem,
      content: "# Shared plan\n\nFor the whole project.\n",
    }),
  );
  await chat.threadId();
  await chat.waitForIdle();
  const panel = page
    .getByRole("tabpanel")
    .filter({ has: page.getByRole("heading", { name: stem }) });
  await expect(panel.getByRole("heading", { name: "Shared plan" })).toBeVisible({
    timeout: RUN_TIMEOUT_MS,
  });

  // ac-2: Add to project on the artifact header: project, folder, name (prefilled).
  await panel.getByRole("button", { name: `Add ${stem}.md to a project`, exact: true }).click();
  const dialog = panel.getByRole("dialog", { name: "Add to project" });
  await dialog.getByLabel("Project").selectOption(projectId);
  await expect(dialog.getByLabel("Name")).toHaveValue(`${stem}.md`);
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  const where = `projects/${slug}/${stem}.md`;
  await expect(dialog.getByText(`Added to ${projectName} as ${where}`)).toBeVisible();
  const listed = await pageApi<{ files: { path: string }[] }>(
    page,
    "GET",
    `/v1/projects/${projectId}/files`,
  );
  expect(listed.json.files.map((f) => f.path)).toEqual([`${stem}.md`]);

  const second = await signInSecond(browser);
  try {
    // The project's files are mounted for every member: Files lists projects/<slug>/<file>.
    await new Chat(second).open();
    const files = filesSection(second);
    await files.getByRole("button", { name: "Refresh files" }).click({ timeout: SHELL_TIMEOUT_MS });
    const tree = files.getByRole("tree", { name: "Files in your workspace" });
    const row = (name: string) => tree.getByRole("treeitem", { name, exact: true });
    await row("projects").click();
    await row(slug).click();
    await row(`${stem}.md`).click();
    // Opened read-only: the editor says so and offers no Save.
    const tab = second
      .getByRole("tabpanel")
      .filter({ has: second.getByRole("heading", { name: `${stem}.md` }) });
    await expect(tab.getByText("Project files and thread uploads are read-only.")).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });
    await expect(tab.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    // The server agrees: the bytes are there, a write is refused.
    const read = await second.evaluate(async (path) => {
      const team = window.localStorage.getItem("kobe.lastTeamId") ?? "";
      const q = encodeURIComponent(path);
      const get = await fetch(`/v1/workspace/file?path=${q}`, { headers: { "x-kobe-team": team } });
      const text = await get.text();
      const put = await fetch(`/v1/workspace/file?path=${q}&base_sha256=${"0".repeat(64)}`, {
        method: "PUT",
        headers: { "x-kobe-team": team, "content-type": "text/plain" },
        body: "overwritten",
      });
      return { get: get.status, text, put: put.status };
    }, where);
    expect(read).toEqual({ get: 200, text: "# Shared plan\n\nFor the whole project.\n", put: 403 });
  } finally {
    await second.context().close();
  }
});
