import type { Page } from "@playwright/test";
import { Chat, expect, filesSection, test } from "./support/chat.js";
import { RUN_TIMEOUT_MS, SHELL_TIMEOUT_MS } from "./support/constants.js";
import {
  deleteWorkspacePath,
  pageApi,
  secondBrowser,
  toolTurn,
  workspaceFile,
} from "./support/gate5.js";
import { panelOf } from "./support/panel.js";

/**
 * KOBE-593 (projects-in-conversations PC-6, spec docs/specs/projects-in-conversations.md, §10).
 * Two projects with files are made through the API (the owner, KOBE_USER, is a Team1 admin).
 *
 * Owner: a new conversation drafted from project A reads "New conversation in A" (NC1); the project
 * control switches to B, removes the project ("New conversation", "Add to a project") and adds A
 * back (NC2); the first send creates the conversation, titled "A / name" (TT1, tab title too). The
 * Files panel lists every project: A has the "Active in this conversation" dot, B is described
 * "Not in this conversation" and expands read-only (FP1, FP2, FP4). The agent proposes an edit to
 * A's file (PE2); Accept commits it (PE4) and the History tab shows the commit. A My files folder
 * is promoted to a project from its menu (PF1-PF3) and shows under Projects and in the control.
 *
 * member2 (KOBE_USER2 / KOBE_PW2, a reader by default, RV1) sees both projects in Files, and the
 * agent's proposal to change A is refused ("You can read A but not change it.", PE1): no card, no
 * commit, and member2 cannot accept the owner's proposal either.
 *
 * Several short model turns; with KOBE_FAKE_MODEL=1 the fake's `tool:` line drives the proposals.
 * Clean-up (finally) trashes the threads and archives and deletes the projects.
 */
const USER2 = process.env["KOBE_USER2"];
const PW2 = process.env["KOBE_PW2"];

const PLAIN = "No tools. Reply with the single word OK.";
const NOTES = "notes.md";
const NOTES_BASE = "alpha\nbeta\n";
const NOTES_EDIT = "alpha\nBETA\n";
const README = "readme.md";
const PROJECT_CONTROL = "Project for this conversation";

interface Created {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

interface Proposal {
  readonly proposal_id: string;
  readonly path: string;
  readonly summary: string;
  readonly project_id?: string;
}

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

async function uploadTo(page: Page, id: string, name: string, text: string): Promise<number> {
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

async function makeProject(
  page: Page,
  name: string,
  files: Record<string, string>,
): Promise<Created> {
  const res = await pageApi<Created>(page, "POST", "/v1/projects", { name });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  for (const [file, text] of Object.entries(files)) {
    expect(await uploadTo(page, res.json.id, file, text)).toBe(201);
  }
  return res.json;
}

/** A project with commits is archived (its history stays); the delete removes the rest. */
async function dropProject(page: Page, id: string): Promise<void> {
  await pageApi(page, "PATCH", `/v1/projects/${id}`, { archived: true });
  await pageApi(page, "DELETE", `/v1/projects/${id}`);
}

const header = (page: Page) => page.locator("#kobe-thread-title");

/** The Projects tree of the Files panel, refreshed. */
async function projectsTree(page: Page) {
  const files = filesSection(page);
  await files.getByRole("button", { name: "Refresh files" }).click({ timeout: SHELL_TIMEOUT_MS });
  return files.getByRole("tree", { name: "Projects" });
}

async function proposals(page: Page, threadId: string): Promise<Proposal[]> {
  const res = await pageApi<{ proposals: Proposal[] }>(
    page,
    "GET",
    `/v1/threads/${threadId}/file-edit-proposals`,
  );
  return res.json.proposals ?? [];
}

async function commitMessages(page: Page, projectId: string): Promise<string[]> {
  const res = await pageApi<{ commits: { message: string }[] }>(
    page,
    "GET",
    `/v1/projects/${projectId}/commits`,
  );
  return (res.json.commits ?? []).map((c) => c.message);
}

test("owner: draft in a project, switch, remove, add back, send; title, Files list, proposal commits", async ({
  chat,
  page,
}) => {
  const stem = `kobe-593-${uniq()}`;
  const ids: string[] = [];
  await chat.open();
  try {
    const a = await makeProject(page, `${stem} A`, { [NOTES]: NOTES_BASE });
    ids.push(a.id);
    const b = await makeProject(page, `${stem} B`, { [README]: "other project\n" });
    ids.push(b.id);

    // NC1: a new conversation started from a project says which one.
    await page.goto(`/?project=${a.id}`);
    await expect(chat.composer).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await chat.showBothPanels("files");
    await expect(header(page)).toContainText(`New conversation in ${a.name}`, {
      timeout: SHELL_TIMEOUT_MS,
    });

    // NC2: switch to B ...
    const control = () => page.getByRole("button", { name: PROJECT_CONTROL, exact: true });
    await control().click();
    const group = page.getByRole("radiogroup", { name: PROJECT_CONTROL });
    await expect(group.getByRole("radio", { name: a.name, exact: true })).toBeChecked();
    // Picking closes the control (the radio leaves the page), so click rather than check().
    await group.getByRole("radio", { name: b.name, exact: true }).click();
    await expect(header(page)).toContainText(`New conversation in ${b.name}`);

    // ... remove it ...
    if (!(await group.isVisible())) await control().click();
    await page.getByRole("button", { name: "Remove project", exact: true }).click();
    await expect(header(page)).toHaveText("New conversation");
    await expect(page.getByRole("button", { name: "Add to a project", exact: true })).toBeVisible();

    // ... and add A back. Nothing is mounted or created before the first send (NC3).
    await page.getByRole("button", { name: "Add to a project", exact: true }).click();
    await page
      .getByRole("radiogroup", { name: PROJECT_CONTROL })
      .getByRole("radio", { name: a.name, exact: true })
      .click();
    await expect(header(page)).toContainText(`New conversation in ${a.name}`);

    // FP2 while drafting: A is active, B greyed.
    let tree = await projectsTree(page);
    const rowOf = (name: string) => tree.getByRole("treeitem", { name, exact: true });
    await expect(
      rowOf(a.name).getByRole("img", { name: "Active in this conversation" }),
    ).toBeVisible({ timeout: SHELL_TIMEOUT_MS });

    // Send: the conversation is created in A; its title reads "A / name" (TT1, TT4).
    const threadId = await chat.ask(PLAIN);
    await expect(header(page)).toContainText(`${a.name} /`, { timeout: SHELL_TIMEOUT_MS });
    await expect(
      page.getByRole("button", { name: `Project ${a.name}`, exact: true }),
    ).toBeVisible();
    await expect.poll(() => page.title()).toContain(`${a.name} / `);
    const thread = await pageApi<{ project_id?: string | null }>(
      page,
      "GET",
      `/v1/threads/${threadId}`,
    );
    expect(thread.json.project_id).toBe(a.id);

    // The project part's menu: Open project, Move to project…, Move out of the project (TT2).
    await page.getByRole("button", { name: `Project ${a.name}`, exact: true }).click();
    const menu = page.getByRole("menu", { name: `Project ${a.name}` });
    await expect(menu.getByRole("menuitem", { name: "Open project" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Move to project…" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Move out of the project" })).toBeVisible();
    await page.keyboard.press("Escape");

    // FP1/FP2: every project is listed; the active one has the dot, the other is greyed.
    tree = await projectsTree(page);
    await expect(rowOf(a.name)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(rowOf(b.name)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(
      rowOf(a.name).getByRole("img", { name: "Active in this conversation" }),
    ).toBeVisible();
    await expect(rowOf(a.name)).not.toHaveAccessibleDescription(/Not in this conversation/);
    await expect(
      rowOf(b.name).getByRole("img", { name: "Active in this conversation" }),
    ).toHaveCount(0);
    await expect(rowOf(b.name)).toHaveAccessibleDescription(/Not in this conversation/);
    await expect(rowOf(b.name).locator("span.text-muted-foreground").first()).toHaveText(b.name);
    await expect(filesSection(page).getByRole("link", { name: "Manage projects →" })).toBeVisible();

    // FP4: the greyed project expands read-only, from its head, without mounting.
    await rowOf(b.name).click();
    const readme = tree.getByRole("treeitem", { name: README, exact: true });
    await expect(readme).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await readme.click();
    const tab = page
      .getByRole("tabpanel")
      .filter({ has: page.getByRole("heading", { name: README }) })
      .first();
    await expect(tab).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(tab.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);

    // PE2-PE3: the agent proposes an edit to a file of the conversation's project.
    const message = `Capitalise beta ${stem}`;
    await chat.send(
      toolTurn("propose_file_edit", {
        path: `/workspace/projects/${a.slug}/${NOTES}`,
        content: NOTES_EDIT,
        summary: message,
      }),
    );
    const card = page.locator(`[data-kobe-file-edit*="${a.slug}/${NOTES}"]`).first();
    await expect(card).toContainText(message, { timeout: RUN_TIMEOUT_MS });
    await chat.waitForIdle();
    const open = await proposals(page, threadId);
    const proposal = open.find((p) => p.summary === message);
    expect(proposal, "the recorded proposal").toBeDefined();
    expect(await commitMessages(page, a.id)).not.toContain(message); // nothing written yet

    // PE4: Accept commits. KOBE-592 builds the card's Accept; until it is deployed the same
    // route answers (the card's click calls it).
    const accept = card.getByRole("button", { name: /^Accept/ });
    if (await accept.count()) {
      await accept.first().click();
    } else {
      const res = await pageApi(page, "POST", `/v1/projects/${a.id}/commits/from-proposal`, {
        thread_id: threadId,
        proposal_id: proposal?.proposal_id,
        message,
      });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
    }
    await expect
      .poll(() => commitMessages(page, a.id), { timeout: SHELL_TIMEOUT_MS })
      .toContain(message);

    // History shows the commit.
    await page.goto(`/me/projects/${a.id}`);
    const detail = panelOf(page);
    await detail.getByRole("tab", { name: "History", exact: true }).click({
      timeout: SHELL_TIMEOUT_MS,
    });
    await expect(detail.getByText(message)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  } finally {
    await chat.trashAll().catch((e: unknown) => console.warn(`trash failed: ${String(e)}`));
    for (const id of ids) await dropProject(page, id);
  }
});

test("a My files folder is promoted to a project and shows under Projects", async ({
  chat,
  page,
}) => {
  const dir = `kobe-593-${uniq()}`;
  let projectId: string | null = null;
  await chat.open();
  try {
    expect(await workspaceFile(page, `${dir}/${NOTES}`, NOTES_BASE)).toBe(201);
    const mine = filesSection(page).getByRole("tree", { name: "My files" });
    await filesSection(page).getByRole("button", { name: "Refresh files" }).click();
    const folder = mine.getByRole("treeitem", { name: dir, exact: true });
    await expect(folder).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await folder.hover();
    await folder.getByRole("button", { name: `Actions for ${dir}` }).click();
    await page.getByRole("menuitem", { name: "Promote to project…" }).click();

    // PF2: one field, prefilled with the folder's name.
    const dialog = filesSection(page).getByRole("dialog", { name: `Promote ${dir} to a project` });
    await expect(dialog.getByLabel("Project name")).toHaveValue(dir);
    await dialog.getByRole("button", { name: "Promote", exact: true }).click();

    // PF3/PF6: the project exists with the folder's file, the tree reveals it, the folder left.
    const tree = filesSection(page).getByRole("tree", { name: "Projects" });
    await expect(tree.getByRole("treeitem", { name: dir, exact: true })).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });
    const list = await pageApi<{ projects: Created[] }>(page, "GET", "/v1/projects");
    projectId = list.json.projects.find((p) => p.name === dir)?.id ?? null;
    expect(projectId, "the new project").not.toBeNull();
    const files = await pageApi<{ files: { path: string }[] }>(
      page,
      "GET",
      `/v1/projects/${projectId}/files`,
    );
    expect(files.json.files.map((f) => f.path)).toEqual([NOTES]);
    await expect(mine.getByRole("treeitem", { name: dir, exact: true })).toHaveCount(0, {
      timeout: SHELL_TIMEOUT_MS,
    });

    // NC2/PF6: a new conversation can pick it.
    await page.goto("/");
    await expect(chat.composer).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await page.getByRole("button", { name: "Add to a project", exact: true }).click();
    await expect(
      page
        .getByRole("radiogroup", { name: PROJECT_CONTROL })
        .getByRole("radio", { name: dir, exact: true }),
    ).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  } finally {
    await deleteWorkspacePath(page, dir); // only if the promote did not happen
    if (projectId) await dropProject(page, projectId);
  }
});

test("member2, a reader by default, sees every project and the proposal to change one is refused", async ({
  chat,
  page,
  browser,
}) => {
  test.skip(!USER2 || !PW2, "KOBE_USER2 and KOBE_PW2 name a second member");
  const stem = `kobe-593-${uniq()}`;
  const ids: string[] = [];
  await chat.open();
  const other = await secondBrowser(browser, USER2, PW2);
  const otherChat = new Chat(other);
  try {
    const a = await makeProject(page, `${stem} A`, { [NOTES]: NOTES_BASE });
    ids.push(a.id);
    const b = await makeProject(page, `${stem} B`, { [README]: "other project\n" });
    ids.push(b.id);
    // A's history before the reader acts: the owner's upload of NOTES only.
    const history = await commitMessages(page, a.id);

    // RV1/FP1: no membership rows, yet every project is listed; A (the conversation's) is active.
    await other.goto(`/?project=${a.id}`);
    await expect(otherChat.composer).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await otherChat.showBothPanels("files");
    const tree = await projectsTree(other);
    const rowOf = (name: string) => tree.getByRole("treeitem", { name, exact: true });
    await expect(rowOf(a.name)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(rowOf(b.name)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(rowOf(a.name)).toHaveAccessibleDescription(/reader/);
    await expect(rowOf(b.name)).toHaveAccessibleDescription(/Not in this conversation/);

    // PE1: a reader's agent cannot propose a change; nothing is recorded, nothing commits.
    const refusal = `You can read ${a.name} but not change it.`;
    const threadId = await otherChat.ask(PLAIN);
    await otherChat.send(
      toolTurn("propose_file_edit", {
        path: `/workspace/projects/${a.slug}/${NOTES}`,
        content: NOTES_EDIT,
        summary: `Reader edit ${stem}`,
      }),
    );
    await otherChat.waitForIdle();
    // The tool's answer reaches the agent (and, in the tool call's details, the member).
    expect
      .soft(await other.getByText(refusal).count(), `the refusal "${refusal}" is on screen`)
      .toBeGreaterThan(0);
    expect(await proposals(other, threadId)).toEqual([]);
    await expect(other.locator(`[data-kobe-file-edit*="${a.slug}/${NOTES}"]`)).toHaveCount(0);
    expect(await commitMessages(other, a.id)).not.toContain(`Reader edit ${stem}`);

    // A reader cannot commit through the API either (PE6): the owner's proposal route needs editor.
    const forged = await pageApi(other, "POST", `/v1/projects/${a.id}/commits/from-proposal`, {
      thread_id: threadId,
      proposal_id: crypto.randomUUID(),
    });
    expect(forged.status).toBeGreaterThanOrEqual(400);
    expect(await commitMessages(other, a.id)).toEqual(history);
  } finally {
    await otherChat.trashAll().catch((e: unknown) => console.warn(`trash failed: ${String(e)}`));
    await other.context().close();
    for (const id of ids) await dropProject(page, id);
  }
});
