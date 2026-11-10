import type { Page } from "@playwright/test";
import { expect, filesSection, test } from "./support/chat.js";
import { RUN_TIMEOUT_MS } from "./support/constants.js";
import { bashTurn, pageApi } from "./support/gate5.js";

/**
 * KOBE-599: the Files panel is current without a browser reload.
 *
 * - ac-1, Refresh = sync now: while a run is still going (its bash sleeps, so no run-end push has
 *   happened), a file the agent just wrote shows after Refresh, before the sandbox's 60 s periodic
 *   push. Each Refresh is checked against the server's listing first, so a periodic push that
 *   happened to land in between is reported instead of passing silently.
 * - ac-2, without any click: an upload made in another tab, the agent's push after a run, and a
 *   new file in a project the member has mounted show in the open panel within seconds, and open
 *   folders stay open.
 *
 * Writes `kobe-599-*` folders in My files and one `kobe-599-*` project (KOBE_USER must be allowed
 * to create projects, as for the projects specs); deletes them at the end. Two short model turns.
 */
const TEAM_KEY = "kobe.lastTeamId";
/** The panel lists again a moment after a change (debounced hint): seconds, never a reload. */
const LIVE_MS = 20_000;
/** How long the run keeps going after writing the file (longer than the Refresh checks). */
const HOLD_S = 45;

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function workspace(page: Page, method: "POST" | "DELETE", path: string, content = "") {
  return page.evaluate(
    async ({ method, path, content, teamKey }) => {
      const team = window.localStorage.getItem(teamKey);
      const headers: Record<string, string> = team ? { "x-kobe-team": team } : {};
      if (method === "DELETE") {
        const q = encodeURIComponent(path);
        return (await fetch(`/v1/workspace/files?path=${q}`, { method, headers })).status;
      }
      const slash = path.lastIndexOf("/");
      const form = new FormData();
      form.set("path", path.slice(0, slash));
      form.set("file", new File([content], path.slice(slash + 1), { type: "text/plain" }));
      return (await fetch("/v1/workspace/files", { method, headers, body: form })).status;
    },
    { method, path, content, teamKey: TEAM_KEY },
  );
}

/** Whether the server's listing (the synced manifest) has `name` in `folder`. */
async function listed(page: Page, folder: string, name: string): Promise<boolean> {
  const res = await pageApi<{ entries?: { name: string }[] }>(
    page,
    "GET",
    `/v1/workspace/files?path=${encodeURIComponent(folder)}`,
  );
  return (res.json.entries ?? []).some((e) => e.name === name);
}

const myFiles = (page: Page) => filesSection(page).getByRole("tree", { name: "My files" });

test("Refresh syncs the running sandbox first: the agent's new file shows before the periodic push (ac-1)", async ({
  chat,
  page,
}) => {
  const dir = `kobe-599-${uniq()}`;
  await chat.open();
  expect(await workspace(page, "POST", `${dir}/seed.txt`, "seed\n")).toBe(201);
  try {
    const files = filesSection(page);
    const refresh = files.getByRole("button", { name: "Refresh files" });
    await refresh.click();
    const folder = myFiles(page).getByRole("treeitem", { name: dir, exact: true });
    await folder.click();
    await expect(folder).toHaveAttribute("aria-expanded", "true");

    await chat.send(bashTurn(`printf 'agent\\n' > /workspace/${dir}/fresh.txt && sleep ${HOLD_S}`));
    await chat.threadId();
    await chat.waitForBusy();
    const fresh = myFiles(page).locator(`[role="treeitem"][data-path="${dir}/fresh.txt"]`);
    let proven = false;
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    while (!proven && Date.now() < deadline) {
      await page.waitForTimeout(3_000);
      const before = await listed(page, dir, "fresh.txt");
      expect(before, "a sandbox push landed before Refresh (periodic push raced); run again").toBe(
        false,
      );
      await refresh.click();
      await expect(refresh).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
      proven = await fresh.isVisible();
      // Still running (bash sleeps): no run-end push can have brought it.
      if (proven) await expect(chat.steering).not.toHaveAttribute("data-state", "idle");
    }
    expect(proven, "Refresh never showed the agent's file").toBe(true);
    await expect(folder).toHaveAttribute("aria-expanded", "true");
    await chat.waitForIdle();
  } finally {
    await workspace(page, "DELETE", dir);
  }
});

test("the open panel lists again by itself: another tab's upload and the agent's push (ac-2)", async ({
  chat,
  page,
  context,
}) => {
  const dir = `kobe-599-${uniq()}`;
  await chat.open();
  const other = await context.newPage();
  await other.goto("/");
  await expect.poll(() => other.evaluate((k) => localStorage.getItem(k), TEAM_KEY)).toBeTruthy();
  try {
    const tree = myFiles(page);
    await expect(tree).toBeVisible();
    // Another tab uploads: the folder appears here without a click.
    expect(await workspace(other, "POST", `${dir}/one.txt`, "one\n")).toBe(201);
    const folder = tree.getByRole("treeitem", { name: dir, exact: true });
    await expect(folder).toBeVisible({ timeout: LIVE_MS });
    await folder.click();
    await expect(tree.locator(`[data-path="${dir}/one.txt"]`)).toBeVisible();
    expect(await workspace(other, "POST", `${dir}/two.txt`, "two\n")).toBe(201);
    await expect(tree.locator(`[data-path="${dir}/two.txt"]`)).toBeVisible({ timeout: LIVE_MS });
    await expect(folder).toHaveAttribute("aria-expanded", "true");

    // The agent writes; its push after the run reaches the open folder without a click.
    await chat.send(bashTurn(`printf 'agent\\n' > /workspace/${dir}/agent.txt`));
    await chat.threadId();
    await chat.waitForIdle();
    await expect(tree.locator(`[data-path="${dir}/agent.txt"]`)).toBeVisible({ timeout: LIVE_MS });
    await expect(folder).toHaveAttribute("aria-expanded", "true");
  } finally {
    await workspace(page, "DELETE", dir);
    await other.close();
  }
});

test("a new file in a mounted project shows in the open panel without a click (ac-2)", async ({
  chat,
  page,
}) => {
  const name = `kobe-599-${uniq()}`;
  await chat.open();
  const made = await pageApi<{ id: string; slug: string }>(page, "POST", "/v1/projects", { name });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const id = made.json.id;
  const upload = (file: string, text: string) =>
    page.evaluate(
      async ({ id, file, text, teamKey }) => {
        const team = window.localStorage.getItem(teamKey);
        const form = new FormData();
        form.set("file", new File([text], file, { type: "text/markdown" }));
        const res = await fetch(`/v1/projects/${id}/files`, {
          method: "POST",
          headers: team ? { "x-kobe-team": team } : {},
          body: form,
        });
        return res.status;
      },
      { id, file, text, teamKey: TEAM_KEY },
    );
  try {
    expect(await upload("first.md", "first\n")).toBe(201);
    const files = filesSection(page);
    await files.getByRole("button", { name: "Refresh files" }).click();
    const projects = files.getByRole("tree", { name: "Projects" });
    const row = projects.getByRole("treeitem", { name, exact: true });
    await expect(row).toBeVisible({ timeout: LIVE_MS });
    await row.click();
    await expect(projects.getByRole("treeitem", { name: "first.md", exact: true })).toBeVisible();
    // A teammate's (here: the API's) change to the project: no click.
    expect(await upload("second.md", "second\n")).toBe(201);
    await expect(projects.getByRole("treeitem", { name: "second.md", exact: true })).toBeVisible({
      timeout: LIVE_MS,
    });
    await expect(row).toHaveAttribute("aria-expanded", "true");
  } finally {
    await pageApi(page, "PATCH", `/v1/projects/${id}`, { archived: true });
    await pageApi(page, "DELETE", `/v1/projects/${id}`);
  }
});
