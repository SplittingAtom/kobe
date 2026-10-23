import type { Page } from "@playwright/test";
import { expect, test } from "./support/chat.js";
import { RUN_TIMEOUT_MS } from "./support/constants.js";
import { pageApi, toolTurn } from "./support/gate5.js";

/**
 * KOBE-489: the proposed-edit card's "Open edits automatically" switch. Off (the default), a
 * proposal only shows its card; turned on, the next live proposal opens its file with the inline
 * diff by itself, focus stays in the composer, and nothing is written until the member commits.
 * Uploads `kobe-489-*\/notes.md`, deletes the folder and turns the switch off again at the end.
 * Two short model turns; the model may word things differently, so only the cards are checked.
 */
const TEAM_KEY = "kobe.lastTeamId";
const PREFERENCES = "/v1/me/preferences";
const BASE = "alpha\nbeta\n";

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

test("proposed edits: the auto-open switch opens the next live proposal with its diff", async ({
  chat,
  page,
}) => {
  const dir = `kobe-489-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const path = `${dir}/notes.md`;
  await chat.open();
  // Start from the default (off), whatever an earlier run left.
  expect((await pageApi(page, "PUT", PREFERENCES, { auto_open_edits: false })).status).toBe(200);
  await page.reload();
  await expect(chat.composer).toBeVisible();
  expect((await workspace(page, "upload", path, BASE)).status).toBe(201);
  const review = page.getByRole("region", { name: "Proposed edit to notes.md" });
  try {
    // Off: the proposal shows its card and nothing opens.
    await chat.send(
      toolTurn("propose_file_edit", {
        path: `/workspace/${path}`,
        content: "alpha\nBETA\n",
        summary: "Capitalise beta",
      }),
    );
    await chat.threadId();
    const first = page.locator(`[data-kobe-file-edit="${path}"]`).first();
    await expect(first).toContainText("Capitalise beta", { timeout: RUN_TIMEOUT_MS });
    await chat.waitForIdle();
    await expect(review).toHaveCount(0);

    // Turn it on from the card: it is stored for the member.
    const toggle = first.getByRole("switch", { name: "Open edits automatically" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect
      .poll(
        async () =>
          (await pageApi<{ preferences: Record<string, unknown> }>(page, "GET", PREFERENCES)).json
            .preferences["auto_open_edits"],
      )
      .toBe(true);
    // Turning it on never opens the proposal that came before.
    await expect(review).toHaveCount(0);

    // On: the next live proposal opens its file with the inline diff; focus stays put.
    await chat.send(
      toolTurn("propose_file_edit", {
        path: `/workspace/${path}`,
        content: "alpha\nbeta\ngamma\n",
        summary: "Add gamma",
      }),
    );
    await expect(review).toBeVisible({ timeout: RUN_TIMEOUT_MS });
    await expect(review.getByRole("button", { name: "Commit all", exact: true })).toBeVisible();
    await expect(chat.composer).toBeFocused();
    await chat.waitForIdle();
    // Nothing is written by itself: committing stays the member's click.
    expect((await workspace(page, "read", path)).text).toBe(BASE);
    await review.getByRole("button", { name: "Discard all", exact: true }).click();
    await expect(review).toHaveCount(0);
    expect((await workspace(page, "read", path)).text).toBe(BASE);
  } finally {
    expect((await pageApi(page, "PUT", PREFERENCES, { auto_open_edits: false })).status).toBe(200);
    expect((await workspace(page, "delete", dir)).status).toBe(204);
  }
});
