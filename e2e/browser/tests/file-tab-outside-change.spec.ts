import type { Page } from "@playwright/test";
import { expect, filesSection, test } from "./support/chat.js";
import { RUN_TIMEOUT_MS } from "./support/constants.js";
import { toolTurn } from "./support/gate5.js";

/**
 * KOBE-491: an open file tab notices the agent's change to its file. With the file open and no
 * unsaved edits, the agent's `write` lands in place with "Updated by the agent just now."; with a
 * draft, nothing is replaced and the banner offers Compare (the inline diff), Keep mine and Take
 * theirs; Keep mine keeps the draft, the next Save is refused with the same choices, and Keep
 * mine there saves over the agent's version. The Viewing chip is dismissed before each turn so the agent writes directly (KOBE-493
 * refuses direct writes to the viewed file). Writes `kobe-491-*\/notes.md`, deletes the folder at
 * the end. Three short model turns; the model may phrase replies freely, only the file matters.
 */
const TEAM_KEY = "kobe.lastTeamId";
const BASE = "alpha\nbeta\ngamma\n";
const FIRST = "alpha\nbeta\ngamma\nfrom the agent\n";
const SECOND = "ALPHA\nbeta\ngamma\nfrom the agent\n";
const THIRD = "ALPHA\nBETA\ngamma\nfrom the agent\n";

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

test("file tab: picks up the agent's write when clean, shows the banner and Compare with a draft", async ({
  chat,
  page,
}) => {
  const dir = `kobe-491-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const path = `${dir}/notes.md`;
  await chat.open();
  expect(await workspace(page, "POST", path, BASE)).toBe(201);
  try {
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
    const notViewing = page.getByRole("button", { name: "Don't send notes.md with the message" });

    // Clean tab: the agent's write lands in place, announced.
    await notViewing.click();
    await chat.send(toolTurn("write", { path: `/workspace/${path}`, content: FIRST }));
    await chat.threadId();
    await expect(tab.getByText("Updated by the agent just now.")).toBeVisible({
      timeout: RUN_TIMEOUT_MS,
    });
    await expect(editor).toContainText("from the agent");

    // With a draft: nothing is replaced; the banner offers the choices.
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("my draft line\n");
    await expect(tab.getByText("Unsaved changes.")).toBeVisible();
    if (await notViewing.isVisible()) await notViewing.click();
    await chat.waitForIdle();
    await chat.send(toolTurn("write", { path: `/workspace/${path}`, content: SECOND }));
    const banner = tab
      .getByRole("alert")
      .filter({ hasText: "The agent changed this file while you were editing." });
    await expect(banner).toBeVisible({ timeout: RUN_TIMEOUT_MS });
    await expect(editor).toContainText("my draft line");
    await expect(editor).not.toContainText("ALPHA");

    await banner.getByRole("button", { name: "Compare", exact: true }).click();
    const diff = page.getByLabel("Your notes.md against the agent's version");
    await expect(diff).toBeVisible();
    await expect(tab.locator(".cm-deletedChunk").first()).toBeVisible();

    page.once("dialog", (dialog) => void dialog.accept());
    await banner.getByRole("button", { name: "Take theirs", exact: true }).click();
    await expect(tab.getByText("Unsaved changes.")).toHaveCount(0);
    await expect(page.getByLabel("Edit notes.md")).toContainText("ALPHA");

    // Keep mine: the banner goes, the draft stays; Save is refused with the same choices, and
    // Keep mine there saves the draft over the agent's version explicitly.
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("kept line\n");
    if (await notViewing.isVisible()) await notViewing.click();
    await chat.waitForIdle();
    await chat.send(toolTurn("write", { path: `/workspace/${path}`, content: THIRD }));
    await expect(banner).toBeVisible({ timeout: RUN_TIMEOUT_MS });
    await banner.getByRole("button", { name: "Keep mine", exact: true }).click();
    await expect(banner).toHaveCount(0);
    await expect(editor).toContainText("kept line");
    await tab.getByRole("button", { name: "Save", exact: true }).click();
    const refused = tab.getByRole("alert").filter({ hasText: "nothing was saved" });
    await expect(refused).toBeVisible();
    await refused.getByRole("button", { name: "Keep mine", exact: true }).click();
    await expect(tab.getByText("Saved.")).toBeVisible();
    await expect(refused).toHaveCount(0);
    await expect(editor).toContainText("kept line");
    await expect(editor).not.toContainText("BETA");
  } finally {
    await workspace(page, "DELETE", dir);
  }
});
