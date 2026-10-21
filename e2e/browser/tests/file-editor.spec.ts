import type { Locator, Page } from "@playwright/test";
import { expect, filesSection, test } from "./support/chat.js";
import { RUN_TIMEOUT_MS } from "./support/constants.js";
import { toolTurn } from "./support/gate5.js";

/**
 * KOBE-463 (spec docs/specs/file-editor.md): a text file of the member's workspace opens in the
 * artifact column with Rendered and Raw modes; a Raw edit is saved at the version it was loaded
 * at; a save over a file that changed meanwhile shows the conflict notice and nothing is
 * overwritten; the composer shows the Viewing chip; the agent's `propose_file_edit` shows as a
 * card whose Review opens the inline diff, where one change is accepted, the other rejected, and
 * Commit all saves the result. The folder is deleted at the end. One short model turn.
 * KOBE-469: CodeMirror's styles apply under the nonce CSP (the gutter sits beside the text, the
 * diff is coloured) and no style-src violation is reported.
 */
const TEAM_KEY = "kobe.lastTeamId";

const BASE = "alpha\nbeta\ngamma\n";
const PROPOSED = "alpha\nBETA\ngamma\ndelta\n";

/** Collects the page's style-src CSP violations from now on (client-side navigation keeps it). */
async function watchStyleViolations(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { kobeStyleViolations: string[] }).kobeStyleViolations = seen;
    document.addEventListener("securitypolicyviolation", (e) => {
      if (e.effectiveDirective.startsWith("style-src")) {
        seen.push(`${e.effectiveDirective} ${e.blockedURI} ${e.sample}`);
      }
    });
  });
}

async function styleViolations(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { kobeStyleViolations: string[] }).kobeStyleViolations,
  );
}

/** The editor's line-number gutter is beside its first line of text, not stacked above it. */
async function expectGutterBeside(scope: Locator): Promise<void> {
  const host = scope.locator("[data-kobe-code-editor]");
  const gutter = await host.locator(".cm-gutters").boundingBox();
  const line = await host.locator(".cm-content .cm-line").first().boundingBox();
  expect(gutter).not.toBeNull();
  expect(line).not.toBeNull();
  if (!gutter || !line) return;
  expect(gutter.x + gutter.width).toBeLessThanOrEqual(line.x + 1);
  expect(gutter.y).toBeLessThan(line.y + line.height); // the gutter's top is not above the line
  expect(gutter.y + gutter.height).toBeGreaterThan(line.y);
}

/** The computed background of the first element matching `selector` in the editor. */
async function backgroundOf(scope: Locator, selector: string): Promise<string> {
  return scope
    .locator("[data-kobe-code-editor]")
    .locator(selector)
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);
}

const TRANSPARENT = ["transparent", "rgba(0, 0, 0, 0)"];

/** The member's own workspace API from the page: upload, delete, read, and save at a version. */
async function workspace(
  page: Page,
  op: "upload" | "delete" | "read" | "overwrite",
  path: string,
  content = "",
): Promise<{ status: number; text: string }> {
  return page.evaluate(
    async ({ op, path, content, teamKey }) => {
      const team = window.localStorage.getItem(teamKey);
      const headers: Record<string, string> = team ? { "x-kobe-team": team } : {};
      const q = encodeURIComponent(path);
      if (op === "delete") {
        const res = await fetch(`/v1/workspace/files?path=${q}`, { method: "DELETE", headers });
        return { status: res.status, text: "" };
      }
      if (op === "upload") {
        const slash = path.lastIndexOf("/");
        const form = new FormData();
        form.set("path", path.slice(0, slash));
        form.set("file", new File([content], path.slice(slash + 1), { type: "text/plain" }));
        const res = await fetch("/v1/workspace/files", { method: "POST", headers, body: form });
        return { status: res.status, text: "" };
      }
      const read = await fetch(`/v1/workspace/file?path=${q}`, { headers });
      const bytes = new Uint8Array(await read.arrayBuffer());
      if (op === "read") return { status: read.status, text: new TextDecoder().decode(bytes) };
      // Another writer (as the agent's push would): a save at the current version.
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const base = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
      const res = await fetch(`/v1/workspace/file?path=${q}&base_sha256=${base}`, {
        method: "PUT",
        headers: { ...headers, "content-type": "text/plain; charset=utf-8" },
        body: content,
      });
      return { status: res.status, text: "" };
    },
    { op, path, content, teamKey: TEAM_KEY },
  );
}

test("file editor: raw edit and save, conflict notice, viewing chip, proposal committed per change", async ({
  chat,
  page,
}) => {
  const dir = `kobe-463-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const path = `${dir}/notes.md`;
  await chat.open();
  await watchStyleViolations(page);
  expect((await workspace(page, "upload", path, BASE)).status).toBe(201);
  try {
    // Open the file from the rail's Files tree: Rendered first.
    const files = filesSection(page);
    await files.getByRole("button", { name: "Refresh files" }).click();
    const tree = files.getByRole("tree", { name: "Files in your workspace" });
    await tree.getByRole("treeitem", { name: dir, exact: true }).click();
    await tree.getByRole("treeitem", { name: "notes.md", exact: true }).click();
    const tab = page
      .getByRole("tabpanel")
      .filter({ has: page.getByRole("button", { name: "Raw", exact: true }) });
    await expect(tab.getByText("beta")).toBeVisible();

    // Raw: edit and save at the loaded version.
    await tab.getByRole("button", { name: "Raw", exact: true }).click();
    const editor = page.getByLabel("Edit notes.md");
    await expect(editor).toBeVisible();
    await expectGutterBeside(tab);
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("edited in raw\n");
    await expect(tab.getByText("Unsaved changes.")).toBeVisible();
    await tab.getByRole("button", { name: "Save", exact: true }).click();
    await expect(tab.getByText("Saved.")).toBeVisible();
    expect((await workspace(page, "read", path)).text).toBe(`${BASE}edited in raw\n`);

    // Someone else saves meanwhile: this save is refused with the notice; Reload shows theirs.
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("never saved\n");
    expect((await workspace(page, "overwrite", path, BASE)).status).toBe(200);
    await tab.getByRole("button", { name: "Save", exact: true }).click();
    const conflict = tab.getByRole("alert").filter({ hasText: "changed since it was opened" });
    await expect(conflict).toBeVisible();
    expect((await workspace(page, "read", path)).text).toBe(BASE);
    page.once("dialog", (dialog) => void dialog.accept());
    await conflict.getByRole("button", { name: "Reload the file" }).click();
    await expect(tab.getByText("Unsaved changes.")).toHaveCount(0);
    await expect(editor).not.toContainText("never saved");

    // The composer says which file goes with the message; the agent proposes an edit to it.
    await expect(page.locator(`[data-kobe-viewing-chip="${path}"]`)).toBeVisible();
    await chat.send(
      toolTurn("propose_file_edit", {
        path: `/workspace/${path}`,
        content: PROPOSED,
        summary: "Capitalise beta and add delta",
      }),
    );
    await chat.threadId();
    const card = page.locator(`[data-kobe-file-edit="${path}"]`);
    await expect(card).toContainText("Capitalise beta and add delta", { timeout: RUN_TIMEOUT_MS });
    await chat.waitForIdle();
    expect((await workspace(page, "read", path)).text).toBe(BASE); // nothing written yet (FE1)

    // Review: accept the first change, reject the other, commit.
    await card.getByRole("button", { name: "Review the proposed edit to notes.md" }).click();
    const review = page.getByRole("region", { name: "Proposed edit to notes.md" });
    await expect(
      review.getByText("2 changes to accept or reject.", { exact: false }),
    ).toBeVisible();
    await expectGutterBeside(review);
    expect(TRANSPARENT).not.toContain(await backgroundOf(review, ".cm-changedLine"));
    expect(TRANSPARENT).not.toContain(await backgroundOf(review, ".cm-deletedChunk"));
    await review.getByRole("button", { name: "Accept this change" }).first().click();
    await expect(review.getByText("1 change to accept or reject.", { exact: false })).toBeVisible();
    await review.getByRole("button", { name: "Reject this change" }).click();
    await expect(
      review.getByText("0 changes to accept or reject.", { exact: false }),
    ).toBeVisible();
    await review.getByRole("button", { name: "Commit all", exact: true }).click();
    await expect(card).toContainText("Committed");
    expect((await workspace(page, "read", path)).text).toBe("alpha\nBETA\ngamma\n");
    expect(await styleViolations(page)).toEqual([]);
  } finally {
    expect((await workspace(page, "delete", dir)).status).toBe(204);
  }
});
