import { expect, test } from "./support/chat.js";
import { RUN_TIMEOUT_MS } from "./support/constants.js";
import { styleViolations, watchStyleViolations } from "./support/csp.js";
import { pageApi, toolTurn } from "./support/gate5.js";

/**
 * KOBE-488: the badge row under the thread title lists the artifact the agent created and the
 * workspace file it wrote, with distinct names; the artifact opens read-only in its artifact tab
 * (Rendered/Raw), the file in the editable file editor. The file's badge comes without a reload
 * (the list is read again until the sandbox has synced the file) and both stay after one. Writes
 * `kobe-488-*\/notes.md` with the agent's `write` tool and deletes the folder at the end. Two short
 * model turns.
 */
test("thread badges: an artifact and a written file each open in their own editor", async ({
  chat,
  page,
}) => {
  const stem = `kobe-488-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const title = stem;
  const path = `${stem}/notes.md`;
  await chat.open();
  await watchStyleViolations(page);
  try {
    await chat.send(
      toolTurn("create_artifact", { kind: "markdown", title, content: "# Badge plan\n" }),
    );
    await chat.threadId();
    await chat.waitForIdle();
    await chat.send(
      toolTurn("write", {
        path: `/workspace/${path}`,
        content: "# Notes\n\nWritten by the agent.\n",
      }),
    );
    await chat.waitForIdle();

    const row = page.getByRole("navigation", { name: "Artifacts and files in this conversation" });
    const artifactBadge = row.getByRole("button", { name: `Open artifact ${title}`, exact: true });
    const fileBadge = row.getByRole("button", { name: `Open file ${path}`, exact: true });
    await expect(artifactBadge).toBeVisible({ timeout: RUN_TIMEOUT_MS });
    await expect(fileBadge).toBeVisible({ timeout: RUN_TIMEOUT_MS });
    await expect(fileBadge).toHaveText("notes.md");
    await expect(fileBadge).toHaveAttribute("title", path);

    // The file: its own tab, in the editor (Raw is editable CodeMirror).
    await fileBadge.click();
    await expect(page.getByRole("tab", { name: "notes.md", selected: true })).toBeVisible();
    await expect(fileBadge).toHaveAttribute("aria-expanded", "true");
    const fileTab = page
      .getByRole("tabpanel")
      .filter({ has: page.getByRole("toolbar", { name: "notes.md view" }) });
    await expect(fileTab.getByText("Written by the agent.")).toBeVisible();
    await fileTab.getByRole("button", { name: "Raw", exact: true }).click();
    await expect(page.getByLabel("Edit notes.md")).toHaveAttribute("contenteditable", "true");

    // The artifact: its artifact tab, read-only.
    await artifactBadge.click();
    await expect(page.getByRole("tab", { name: title, exact: true, selected: true })).toBeVisible();
    await expect(artifactBadge).toHaveAttribute("aria-expanded", "true");
    const panel = page
      .getByRole("tabpanel")
      .filter({ has: page.getByRole("heading", { name: title }) });
    await expect(panel.getByRole("heading", { name: "Badge plan" })).toBeVisible();
    await panel.getByRole("button", { name: "Raw", exact: true }).click();
    const raw = page.getByLabel(`${title} (version 1, read-only)`);
    await expect(raw).toHaveAttribute("contenteditable", "false");

    // Both badges come back after a reload.
    await page.reload();
    await expect(artifactBadge).toBeVisible({ timeout: RUN_TIMEOUT_MS });
    await expect(fileBadge).toBeVisible();
    expect(await styleViolations(page)).toEqual([]);
  } finally {
    await pageApi(page, "DELETE", `/v1/workspace/files?path=${encodeURIComponent(stem)}`);
  }
});
