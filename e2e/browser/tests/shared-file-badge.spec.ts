import type { Browser, Page } from "@playwright/test";
import { Chat, expect, filesSection, test } from "./support/chat.js";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";

/**
 * KOBE-496: a file changed while it is open in the code editor. The member has `notes.md` open
 * in one tab; another tab of theirs saves it: the first tab shows "You changed this file in
 * another tab or device just now." with Reload and keeps its text until Reload (ac-1); with a
 * draft, the next save from the other tab brings KOBE-491's Compare / Keep mine / Take theirs
 * and nothing typed is lost (ac-2). With a second member (KOBE_USER2 / KOBE_PW2, member2 on
 * gate1), both have the same path open in their own workspaces: the owner's change badges only
 * the owner's tab, never the second member's, whose own save then badges theirs (ac-4). No model
 * turn. Writes `kobe-496-*\/notes.md` in each workspace and deletes the folder at the end.
 */
const SECOND_USER = process.env["KOBE_USER2"];
const SECOND_PW = process.env["KOBE_PW2"];
const TEAM_KEY = "kobe.lastTeamId";
const BASE = "alpha\nbeta\ngamma\n";
const BADGE = "You changed this file in another tab or device just now.";
/** The badge follows a save within a few seconds (stream hint, debounced read). */
const BADGE_TIMEOUT_MS = 10_000;

type WorkspaceCall =
  | { readonly op: "upload"; readonly path: string; readonly content: string }
  | { readonly op: "save"; readonly path: string; readonly content: string }
  | { readonly op: "delete"; readonly path: string };

/** The workspace API as the page's member (session cookie, active team). Returns the status. */
async function workspace(page: Page, call: WorkspaceCall): Promise<number> {
  return page.evaluate(
    async ({ call, teamKey }) => {
      const team = window.localStorage.getItem(teamKey);
      const headers: Record<string, string> = team ? { "x-kobe-team": team } : {};
      const slash = call.path.lastIndexOf("/");
      const folder = call.path.slice(0, slash);
      if (call.op === "delete") {
        const q = encodeURIComponent(call.path);
        return (await fetch(`/v1/workspace/files?path=${q}`, { method: "DELETE", headers })).status;
      }
      if (call.op === "upload") {
        const form = new FormData();
        form.set("path", folder);
        form.set("file", new File([call.content], call.path.slice(slash + 1)));
        return (await fetch("/v1/workspace/files", { method: "POST", headers, body: form })).status;
      }
      // A save as the editor makes it: at the version the folder lists now.
      const listing = await fetch(`/v1/workspace/files?path=${encodeURIComponent(folder)}`, {
        headers,
      });
      const entries = ((await listing.json()) as { entries: { path: string; sha256?: string }[] })
        .entries;
      const base = entries.find((e) => e.path === call.path)?.sha256 ?? "";
      const q = new URLSearchParams({ path: call.path, base_sha256: base });
      const res = await fetch(`/v1/workspace/file?${q.toString()}`, {
        method: "PUT",
        headers: { ...headers, "content-type": "text/plain; charset=utf-8" },
        body: call.content,
      });
      return res.status;
    },
    { call, teamKey: TEAM_KEY },
  );
}

/** Opens `dir/notes.md` from the rail's Files tree in Raw; returns the tab and its editor. */
async function openNotes(page: Page, dir: string) {
  const files = filesSection(page);
  await files.getByRole("button", { name: "Refresh files" }).click();
  const tree = files.getByRole("tree", { name: "Files in your workspace" });
  await tree.getByRole("treeitem", { name: dir, exact: true }).click();
  await tree.getByRole("treeitem", { name: "notes.md", exact: true }).click();
  const tab = page
    .getByRole("tabpanel")
    .filter({ has: page.getByRole("toolbar", { name: "notes.md view" }) });
  await tab.getByRole("button", { name: "Raw", exact: true }).click();
  const editor = page.getByLabel("Edit notes.md");
  await expect(editor).toContainText("beta");
  return { tab, editor };
}

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

const uniqueDir = () =>
  `kobe-496-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

test("another tab's save: badge with Reload when clean, the choices with a draft", async ({
  chat,
  page,
}) => {
  const dir = uniqueDir();
  const path = `${dir}/notes.md`;
  await chat.open();
  expect(await workspace(page, { op: "upload", path, content: BASE })).toBe(201);
  const other = await page.context().newPage();
  try {
    await other.goto("/");
    const { tab, editor } = await openNotes(page, dir);

    // Clean: the badge names who, nothing is replaced until Reload.
    expect(await workspace(other, { op: "save", path, content: `${BASE}from tab two\n` })).toBe(
      200,
    );
    const badge = tab.locator("[data-kobe-changed-badge]");
    await expect(badge).toHaveText(new RegExp(BADGE.replace(/\./g, "\\.")), {
      timeout: BADGE_TIMEOUT_MS,
    });
    // Inside the always-mounted live region (announced by screen readers).
    await expect(tab.locator("[data-kobe-changes-status]")).toHaveAttribute("role", "status");
    await expect(editor).not.toContainText("from tab two");
    await badge.getByRole("button", { name: "Reload notes.md" }).click();
    await expect(editor).toContainText("from tab two");
    await expect(badge).toHaveCount(0);

    // A draft: nothing typed is lost; KOBE-491's choices, naming who.
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("typed here\n");
    await expect(tab.getByText("Unsaved changes.")).toBeVisible();
    expect(
      await workspace(other, { op: "save", path, content: `${BASE}from tab two\nagain\n` }),
    ).toBe(200);
    const banner = tab.getByRole("alert");
    await expect(banner).toContainText("You changed this file in another tab or device", {
      timeout: BADGE_TIMEOUT_MS,
    });
    for (const name of ["Compare", "Keep mine", "Take theirs"]) {
      await expect(banner.getByRole("button", { name, exact: true })).toBeVisible();
    }
    await expect(editor).toContainText("typed here");
    await expect(badge).toHaveCount(0);
  } finally {
    await other.close();
    await workspace(page, { op: "delete", path: dir });
  }
});

test("two members, same path: only the member whose file changed gets the badge", async ({
  chat,
  page,
  browser,
}) => {
  test.skip(!SECOND_USER || !SECOND_PW, "KOBE_USER2 and KOBE_PW2 name a second member");
  const dir = uniqueDir();
  const path = `${dir}/notes.md`;
  await chat.open();
  const second = await signInSecond(browser);
  const secondChat = new Chat(second);
  try {
    await secondChat.open();
    expect(await workspace(page, { op: "upload", path, content: BASE })).toBe(201);
    expect(await workspace(second, { op: "upload", path, content: BASE })).toBe(201);
    const owner = await openNotes(page, dir);
    const member = await openNotes(second, dir);

    // The owner's other tab saves: the owner's tab is badged.
    const ownerOther = await page.context().newPage();
    await ownerOther.goto("/");
    expect(await workspace(ownerOther, { op: "save", path, content: `${BASE}owner\n` })).toBe(200);
    await expect(owner.tab.locator("[data-kobe-changed-badge]")).toBeVisible({
      timeout: BADGE_TIMEOUT_MS,
    });
    await ownerOther.close();
    // The second member's tab of the same path (their own file) hears nothing of it.
    await second.waitForTimeout(3_000);
    await expect(member.tab.locator("[data-kobe-changed-badge]")).toHaveCount(0);
    await expect(member.editor).not.toContainText("owner");

    // Their own other tab's save does badge theirs: the stream was live all along.
    const memberOther = await second.context().newPage();
    await memberOther.goto("/");
    expect(await workspace(memberOther, { op: "save", path, content: `${BASE}member\n` })).toBe(
      200,
    );
    await expect(member.tab.locator("[data-kobe-changed-badge]")).toBeVisible({
      timeout: BADGE_TIMEOUT_MS,
    });
    await memberOther.close();
  } finally {
    await workspace(page, { op: "delete", path: dir });
    await workspace(second, { op: "delete", path: dir });
    await secondChat.trashAll();
    await second.context().close();
  }
});
