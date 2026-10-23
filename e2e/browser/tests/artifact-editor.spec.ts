import type { Page } from "@playwright/test";
import { expect, test } from "./support/chat.js";
import { RUN_TIMEOUT_MS } from "./support/constants.js";
import { styleViolations, watchStyleViolations } from "./support/csp.js";
import { pageApi, toolTurn } from "./support/gate5.js";

/** A file of the member's own workspace as text, read from the page (session and team). */
async function readFile(page: Page, path: string): Promise<{ status: number; text: string }> {
  return page.evaluate(async (path) => {
    const team = window.localStorage.getItem("kobe.lastTeamId");
    const res = await fetch(`/v1/workspace/file?path=${encodeURIComponent(path)}`, {
      headers: team ? { "x-kobe-team": team } : {},
    });
    return { status: res.status, text: await res.text() };
  }, path);
}

/**
 * KOBE-485: a markdown artifact the agent creates opens in the file editor's UI, read-only:
 * Rendered first, Raw is CodeMirror that takes no typing (styled under the nonce CSP), with the
 * version picker. Edit as file copies the version into `artifacts/<slug>.md` (never overwriting:
 * a second copy is `-2`) and opens that file in an editable tab. The copies are deleted at the end.
 * One short model turn.
 */
test("artifact editor: text artifact read-only in Rendered/Raw, Edit as file opens an editable copy", async ({
  chat,
  page,
}) => {
  const stem = `kobe-485-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const title = stem;
  await chat.open();
  await watchStyleViolations(page);
  await chat.send(
    toolTurn("create_artifact", {
      kind: "markdown",
      title,
      content: "# Artifact plan\n\nShip it.\n",
    }),
  );
  await chat.threadId(); // create_artifact never asks (PROMPT_EXEMPT_KOBE_TOOLS)
  await chat.waitForIdle();
  const copies = [`artifacts/${stem}.md`, `artifacts/${stem}-2.md`];
  try {
    // The agent's artifact opens by itself as the active tab: Rendered, read-only, versions.
    const panel = page
      .getByRole("tabpanel")
      .filter({ has: page.getByRole("heading", { name: title }) });
    await expect(panel.getByRole("heading", { name: "Artifact plan" })).toBeVisible({
      timeout: RUN_TIMEOUT_MS,
    });
    await expect(panel.getByText("Version 1 of 1")).toBeVisible();
    await expect(panel.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);

    // Raw: CodeMirror, read-only.
    await panel.getByRole("button", { name: "Raw", exact: true }).click();
    const raw = page.getByLabel(`${title} (version 1, read-only)`);
    await expect(raw).toBeVisible();
    await expect(raw).toHaveAttribute("contenteditable", "false");
    await raw.click();
    await page.keyboard.type("typed");
    await expect(raw).not.toContainText("typed");
    await expect(raw).toContainText("# Artifact plan");

    // Edit as file: an editable copy in its own tab.
    await panel.getByRole("button", { name: "Edit as file", exact: true }).click();
    await expect(page.getByRole("tab", { name: `${stem}.md`, selected: true })).toBeVisible();
    const fileTab = page
      .getByRole("tabpanel")
      .filter({ has: page.getByRole("button", { name: "Save", exact: true }) });
    await fileTab.getByRole("button", { name: "Raw", exact: true }).click();
    const editor = page.getByLabel(`Edit ${stem}.md`);
    await expect(editor).toHaveAttribute("contenteditable", "true");
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("edited copy\n");
    await fileTab.getByRole("button", { name: "Save", exact: true }).click();
    await expect(fileTab.getByText("Saved.")).toBeVisible();

    // A second copy never overwrites the first.
    await page.getByRole("tab", { name: title, exact: true }).click();
    await panel.getByRole("button", { name: "Edit as file", exact: true }).click();
    await expect(page.getByRole("tab", { name: `${stem}-2.md`, selected: true })).toBeVisible();
    const first = await readFile(page, copies[0] ?? "");
    expect(first.status).toBe(200);
    expect(first.text).toContain("edited copy");
    // A real model may drop the trailing newline from the content it sends.
    expect((await readFile(page, copies[1] ?? "")).text.trimEnd()).toBe(
      "# Artifact plan\n\nShip it.",
    );

    // The artifact itself is unchanged.
    await page.getByRole("tab", { name: title, exact: true }).click();
    await panel.getByRole("button", { name: "Rendered", exact: true }).click();
    await expect(panel.getByText("edited copy")).toHaveCount(0);
    expect(await styleViolations(page)).toEqual([]);
  } finally {
    for (const path of copies) {
      await pageApi(page, "DELETE", `/v1/workspace/files?path=${encodeURIComponent(path)}`);
    }
  }
});
