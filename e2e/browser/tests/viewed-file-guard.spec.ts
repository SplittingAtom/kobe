import type { Page } from "@playwright/test";
import { expect, filesSection, test } from "./support/chat.js";
import { RUN_TIMEOUT_MS } from "./support/constants.js";
import { FAKE_MODEL } from "./support/gate5.js";

/**
 * KOBE-493: while the member views a file, the agent cannot write it directly. Asked to overwrite
 * the open file with its write tool, the server refuses the write (the model is told to propose
 * instead), so the change arrives as a proposal card or the refusal shows on the tool card; the
 * file is unchanged until the member commits a proposal. A real model may take either path, so
 * both are accepted; the file must never change by itself. Uploads `kobe-493-*\/notes.md` and
 * deletes the folder at the end. One short model turn.
 */
const TEAM_KEY = "kobe.lastTeamId";
const BASE = "alpha\nbeta\ngamma\n";
const WANTED = "alpha\nBETA\ngamma\n";

async function workspace(
  page: Page,
  op: "upload" | "delete" | "read",
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
      return { status: read.status, text: await read.text() };
    },
    { op, path, content, teamKey: TEAM_KEY },
  );
}

function writeTurn(path: string): string {
  const args = { path: `/workspace/${path}`, content: WANTED };
  return FAKE_MODEL
    ? `tool: write ${JSON.stringify(args)}`
    : `Use your write tool to overwrite /workspace/${path} with exactly this content: ${JSON.stringify(WANTED)}. If that is refused, follow the refusal's advice. Then reply DONE.`;
}

test("viewed file: the agent's write to the open file is refused or becomes a proposal", async ({
  chat,
  page,
}) => {
  const dir = `kobe-493-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const path = `${dir}/notes.md`;
  await chat.open();
  expect((await workspace(page, "upload", path, BASE)).status).toBe(201);
  try {
    // Open the file from the rail's Files tree: the composer then says it is being viewed.
    const files = filesSection(page);
    await files.getByRole("button", { name: "Refresh files" }).click();
    const tree = files.getByRole("tree", { name: "Files in your workspace" });
    await tree.getByRole("treeitem", { name: dir, exact: true }).click();
    await tree.getByRole("treeitem", { name: "notes.md", exact: true }).click();
    await expect(page.locator(`[data-kobe-viewing-chip="${path}"]`)).toBeVisible();

    await chat.send(writeTurn(path));
    await chat.threadId();
    await chat.waitForIdle(RUN_TIMEOUT_MS);

    // Never written directly.
    expect((await workspace(page, "read", path)).text).toBe(BASE);

    const proposal = page.locator(`[data-kobe-file-edit="${path}"]`);
    const refusal = page.getByText("Denied by policy").first();
    await expect(proposal.or(refusal).first()).toBeVisible({ timeout: RUN_TIMEOUT_MS });

    if ((await proposal.count()) > 0) {
      // The change lands only once the member commits it.
      await proposal
        .first()
        .getByRole("button", { name: "Review the proposed edit to notes.md" })
        .click();
      const review = page.getByRole("region", { name: "Proposed edit to notes.md" });
      await review.getByRole("button", { name: "Commit all", exact: true }).click();
      await expect(proposal.first()).toContainText("Committed");
      expect((await workspace(page, "read", path)).text).not.toBe(BASE);
    }
  } finally {
    expect((await workspace(page, "delete", dir)).status).toBe(204);
  }
});
