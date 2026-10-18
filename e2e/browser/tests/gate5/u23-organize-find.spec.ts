import { RUN_TIMEOUT_MS } from "../support/constants.js";
import { expect, test } from "../support/chat.js";
import { deleteWorkspacePath, pageApi, regions, workspaceFile } from "../support/gate5.js";

/**
 * Gate 5, U23 (KOBE-227): "A title appears after the first run and a rename stops auto-titling;
 * pin, archive and move to project are reflected in the rail groups; the palette finds threads and
 * files; an `@file` mention reaches the prompt as a sandbox path." auto-title, organize,
 * command-palette and file-mentions specs prove most of it; the rename lock and the palette's
 * files are here.
 */
test("U23: a renamed thread keeps its name through later runs (auto-titling stops)", async ({
  chat,
  page,
}) => {
  await chat.open();
  const id = await chat.ask("No tools. Reply with the single word TITLED.");
  const header = page.locator("header").filter({ has: page.locator("#kobe-thread-title") });
  const name = `G5 renamed ${Date.now().toString(36)}`;
  await header.getByRole("button", { name: /^Rename / }).click();
  const field = page.getByRole("textbox", { name: "Conversation name", exact: true });
  await field.fill(name);
  await field.press("Enter");
  await expect(page.locator("#kobe-thread-title")).toHaveText(name);
  await chat.ask("No tools. Reply with the single word AGAIN.");
  await chat.ask("No tools. Reply with the single word THIRD.");
  // The post-run title call had two chances; the member's name stays, on the server too.
  await page.waitForTimeout(5_000);
  const thread = await pageApi<{ title?: string; title_locked?: boolean }>(
    page,
    "GET",
    `/v1/threads/${id}`,
  );
  expect(thread.json.title).toBe(name);
  await page.reload();
  await expect(page.locator("#kobe-thread-title")).toHaveText(name, { timeout: RUN_TIMEOUT_MS });
});

test("U23: the palette finds a workspace file and opens it", async ({ chat, page }) => {
  const dir = `g5find${Date.now().toString(36)}`;
  const file = `${dir}-notes.txt`;
  await chat.open();
  expect(await workspaceFile(page, `${dir}/${file}`, "found by the palette\n")).toBe(201);
  try {
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await page.locator("body").press("ControlOrMeta+k");
    await palette.getByRole("combobox").pressSequentially(dir);
    const files = palette.getByRole("group", { name: "Files" });
    const option = files.getByRole("option", { name: new RegExp(file) });
    await expect(option).toBeVisible({ timeout: 15_000 });
    await option.click();
    await expect(palette).toBeHidden();
    await expect(regions(page).artifact.getByRole("tab", { name: new RegExp(file) })).toBeVisible();
  } finally {
    await deleteWorkspacePath(page, dir);
  }
});
