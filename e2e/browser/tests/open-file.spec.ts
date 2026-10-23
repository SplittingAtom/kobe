import type { Page } from "@playwright/test";
import { expect, test } from "./support/chat.js";
import { RUN_TIMEOUT_MS } from "./support/constants.js";
import { FAKE_MODEL } from "./support/gate5.js";

/**
 * KOBE-484: asking the agent to open a workspace file opens it in the artifact column's file
 * editor (Rendered and Raw), through the agent's `open_file` tool, and the thread shows the
 * "Opened notes.md" card with Open again. Uploads `kobe-484-*\/notes.md` through the files API and
 * deletes the folder at the end. One short model turn.
 */
const TEAM_KEY = "kobe.lastTeamId";

async function workspace(
  page: Page,
  op: "upload" | "delete",
  path: string,
  content = "",
): Promise<number> {
  return page.evaluate(
    async ({ op, path, content, teamKey }) => {
      const team = window.localStorage.getItem(teamKey);
      const headers: Record<string, string> = team ? { "x-kobe-team": team } : {};
      if (op === "delete") {
        const q = encodeURIComponent(path);
        const res = await fetch(`/v1/workspace/files?path=${q}`, { method: "DELETE", headers });
        return res.status;
      }
      const slash = path.lastIndexOf("/");
      const form = new FormData();
      form.set("path", path.slice(0, slash));
      form.set("file", new File([content], path.slice(slash + 1), { type: "text/markdown" }));
      const res = await fetch("/v1/workspace/files", { method: "POST", headers, body: form });
      return res.status;
    },
    { op, path, content, teamKey: TEAM_KEY },
  );
}

test("open_file: asking the agent to open notes.md opens it in the editor tab", async ({
  chat,
  page,
}) => {
  const dir = `kobe-484-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const path = `${dir}/notes.md`;
  await chat.open();
  expect(await workspace(page, "upload", path, "# Notes\n\nOpened by the agent.\n")).toBe(201);
  try {
    await chat.send(
      FAKE_MODEL
        ? `tool: open_file ${JSON.stringify({ path: `/workspace/${path}` })}`
        : `Open ${path}`,
    );
    await chat.threadId();
    const card = page.locator(`[data-kobe-opened-file="${path}"]`);
    await expect(card).toContainText("Opened notes.md", { timeout: RUN_TIMEOUT_MS });
    // The file's tab opened by itself, in the editor: Rendered first, Raw one click away.
    const tab = page
      .getByRole("tabpanel")
      .filter({ has: page.getByRole("toolbar", { name: "notes.md view" }) });
    await expect(tab.getByRole("button", { name: "Rendered", exact: true })).toBeVisible();
    await expect(tab.getByRole("button", { name: "Raw", exact: true })).toBeVisible();
    await expect(tab.getByText("Opened by the agent.")).toBeVisible();
    await chat.waitForIdle();
    // Not a download card or an artifact copy.
    await expect(page.locator("[data-kobe-file-edit]")).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Open notes.md again" })).toBeVisible();
  } finally {
    expect(await workspace(page, "delete", dir)).toBe(204);
  }
});
