import type { Page } from "@playwright/test";
import { expect, test } from "./support/chat.js";
import { RUN_TIMEOUT_MS } from "./support/constants.js";
import { FAKE_MODEL } from "./support/gate5.js";

/** The fake model (CI) runs `bash: <command>`; a real one is asked to read the file. */
const LEAD = FAKE_MODEL ? "bash: cat" : "Use a tool to read";

/**
 * KOBE-223 (CE22): a file dropped into the member's workspace (`uploads/`, the rail's drop
 * folder) is mentioned with `@` in the composer: the picker lists it, Enter picks it, a chip shows,
 * and the sent prompt names the file's absolute sandbox path, which the agent's tool call reads.
 * The file is deleted again at the end. The k3d suite (`e2e/run.sh`, "mentions") proves the read
 * with the fake model; this spec shows the picker and the real agent on a deployment.
 */
const TEAM_KEY = "kobe.lastTeamId";

/** The member's own workspace API, called from the page (session cookie, CSRF Origin). */
async function workspace(
  page: Page,
  method: "POST" | "DELETE",
  name: string,
  content = "",
): Promise<number> {
  return page.evaluate(
    async ({ method, name, content, teamKey }) => {
      const team = window.localStorage.getItem(teamKey);
      const headers: Record<string, string> = team ? { "x-kobe-team": team } : {};
      if (method === "DELETE") {
        const path = encodeURIComponent(`uploads/${name}`);
        return (await fetch(`/v1/workspace/files?path=${path}`, { method, headers })).status;
      }
      const form = new FormData();
      form.set("path", "uploads");
      form.set("file", new File([content], name, { type: "text/plain" }));
      return (await fetch("/v1/workspace/files", { method, headers, body: form })).status;
    },
    { method, name, content, teamKey: TEAM_KEY },
  );
}

test("@file mention: pick a workspace file, the agent reads it by its absolute path", async ({
  chat,
  page,
}) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const name = `kobe-223-${stamp}.txt`;
  const absolute = `/workspace/uploads/${name}`;
  await chat.open();
  expect(await workspace(page, "POST", name, `mention-check ${stamp}\n`)).toBe(201);
  try {
    await chat.composer.fill("");
    await chat.composer.pressSequentially(`${LEAD} @kobe-223-${stamp}`);
    const list = page.getByRole("listbox", { name: "Workspace files" });
    await expect(list).toBeVisible();
    await expect(list.getByRole("option").first()).toContainText(name);
    await expect(chat.composer).toHaveAttribute("aria-expanded", "true");
    await chat.composer.press("Enter");
    await expect(list).toBeHidden();
    await expect(chat.composer).toHaveValue(`${LEAD} @file(uploads/${name}) `);
    await expect(
      page.getByRole("list", { name: "Mentioned files" }).getByText(`@uploads/${name}`),
    ).toBeVisible();
    if (!FAKE_MODEL)
      await chat.composer.pressSequentially("and quote its one line. Do nothing else.");
    await chat.composer.press("Enter");
    await chat.threadId();

    // The server rewrote the marker: the prompt shows the absolute sandbox path.
    await expect(chat.userMessages.last()).toContainText(absolute, { timeout: RUN_TIMEOUT_MS });
    await expect(chat.userMessages.last()).not.toContainText("@file(");
    await chat.waitForIdle();
    // A tool call of the run names exactly that path, and the answer quotes the file.
    const calls = page.getByRole("region", { name: /^Tool call / });
    await expect(calls.filter({ hasText: absolute }).first()).toBeVisible();
    await expect(chat.answers.last()).toContainText(stamp);
  } finally {
    await workspace(page, "DELETE", name);
  }
});
