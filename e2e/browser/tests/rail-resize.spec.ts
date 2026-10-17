import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./support/chat.js";

/**
 * KOBE-305: the resizable rail. Drags the handle on the rail's right edge, checks the width
 * survives a reload, the keyboard (Home/End) and its bounds, Mod+B collapse and expand (the width
 * comes back), double-click back to 280 px, no handle at 960 and 390 px, and the bounds beside an
 * open file tab (the artifact column): the conversation keeps 400 px and the column 360 px.
 * Screenshots of the widened rail with the Files tree in light and dark land in test-results/.
 * Uploads one small file and deletes it at the end. No model tokens.
 */
const TEAM_KEY = "kobe.lastTeamId";
const RAIL_WIDTH_KEY = "kobe.railWidth";
const THEME_COOKIE = "kobe-theme";
/** CSS px are whole at 1280 × 800; allow a pixel for borders and rounding. */
const SLACK_PX = 1;

/** The member's own workspace API, called from the page (session cookie, CSRF Origin). */
async function api(page: Page, method: "POST" | "DELETE", path: string): Promise<number> {
  return page.evaluate(
    async ({ method, path, teamKey }) => {
      const team = window.localStorage.getItem(teamKey);
      const headers: Record<string, string> = team ? { "x-kobe-team": team } : {};
      if (method === "DELETE") {
        const q = encodeURIComponent(path);
        return (await fetch(`/v1/workspace/files?path=${q}`, { method, headers })).status;
      }
      const slash = path.lastIndexOf("/");
      const form = new FormData();
      form.set("path", path.slice(0, slash));
      form.set("file", new File(["# Notes\n"], path.slice(slash + 1), { type: "text/markdown" }));
      return (await fetch("/v1/workspace/files", { method, headers, body: form })).status;
    },
    { method, path, teamKey: TEAM_KEY },
  );
}

const width = async (l: Locator) => (await l.boundingBox())?.width ?? 0;

async function expectWidth(l: Locator, px: number) {
  await expect.poll(() => width(l)).toBeGreaterThanOrEqual(px - SLACK_PX);
  await expect.poll(() => width(l)).toBeLessThanOrEqual(px + SLACK_PX);
}

const stored = (page: Page) =>
  page.evaluate((key) => window.localStorage.getItem(key), RAIL_WIDTH_KEY);

test("rail resize: drag, reload, keys, Mod+B, reset, narrow widths, beside a file tab", async ({
  chat,
  page,
  context,
  baseURL,
}, testInfo) => {
  await chat.open();
  await page.evaluate((key) => window.localStorage.removeItem(key), RAIL_WIDTH_KEY);
  await page.reload();
  const rail = page.locator('[data-shell-region="rail"]');
  const conversation = page.locator('[data-shell-region="conversation"]');
  const column = page.locator('[data-shell-region="artifact"]');
  const handle = page.getByRole("separator", { name: "Resize the workspace rail" });
  await expect(handle).toBeVisible();
  await expect(handle).toHaveAttribute("aria-orientation", "vertical");
  await expectWidth(rail, 280);

  // Drag 120 px to the right: 400 px, remembered in this browser.
  const box = await handle.boundingBox();
  if (!box) throw new Error("the rail's handle has no box");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, y, { steps: 4 });
  await page.mouse.move(box.x + box.width / 2 + 120, y, { steps: 4 });
  await page.mouse.up();
  await expectWidth(rail, 400);
  await expect.poll(() => stored(page)).toBe("400");
  await page.reload();
  await expectWidth(rail, 400);

  // Screenshots with the Files tree, light and dark.
  const files = page.getByRole("region", { name: "Files" });
  const openFiles = files.getByRole("button", { name: "Open files" });
  if (await openFiles.isVisible()) await openFiles.click();
  await expect(files.getByRole("tree", { name: "Files in your workspace" })).toBeVisible();
  for (const theme of ["light", "dark"] as const) {
    await context.addCookies([{ name: THEME_COOKIE, value: theme, url: baseURL ?? "" }]);
    await page.reload();
    await expectWidth(rail, 400);
    await handle.hover();
    await page.screenshot({ path: testInfo.outputPath(`rail-resize-${theme}.png`) });
  }
  await context.clearCookies({ name: THEME_COOKIE });
  await page.reload();

  // Keys: Home is 200 px, End 560 px (1,280 − 400 leaves more room than the rail's maximum).
  await handle.focus();
  await page.keyboard.press("Home");
  await expectWidth(rail, 200);
  await expect(handle).toHaveAttribute("aria-valuenow", "200");
  await page.keyboard.press("End");
  await expectWidth(rail, 560);
  expect(await width(conversation)).toBeGreaterThanOrEqual(400);

  // Mod+B: collapsed, no handle; expanded again, the width comes back.
  await chat.composer.focus();
  await chat.composer.press("ControlOrMeta+b");
  await expect(handle).toHaveCount(0);
  await expectWidth(rail, 48);
  await chat.composer.press("ControlOrMeta+b");
  await expect(handle).toBeVisible();
  await expectWidth(rail, 560);

  // Double-click: back to 280 px, forgotten.
  await handle.dblclick();
  await expectWidth(rail, 280);
  await expect.poll(() => stored(page)).toBeNull();

  // Narrow and phone widths: no handle (the rail is 48 px or a drawer, as before).
  for (const w of [960, 390]) {
    await page.setViewportSize({ width: w, height: 800 });
    await expect(handle).toHaveCount(0);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(handle).toBeVisible();

  // Beside an open file tab: End stops where the conversation and the column keep their floors.
  const dir = `kobe-305-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  expect(await api(page, "POST", `${dir}/notes.md`)).toBe(201);
  try {
    if (await openFiles.isVisible()) await openFiles.click();
    await files.getByRole("button", { name: "Refresh files" }).click();
    const tree = files.getByRole("tree", { name: "Files in your workspace" });
    await tree.getByRole("treeitem", { name: dir, exact: true }).click();
    await tree.getByRole("treeitem", { name: "notes.md", exact: true }).click();
    await expect(column).toBeVisible();
    await expect(
      page.getByRole("separator", { name: "Resize the artifact column and the conversation" }),
    ).toBeVisible();
    await handle.focus();
    await page.keyboard.press("End");
    await expect(handle).toHaveAttribute("aria-valuemax", "520"); // 1,280 − 400 − 360
    await expectWidth(rail, 520);
    expect(await width(column)).toBeGreaterThanOrEqual(360 - SLACK_PX);
    expect(await width(conversation)).toBeGreaterThanOrEqual(400 - SLACK_PX);
    await page.screenshot({ path: testInfo.outputPath("rail-resize-with-column.png") });
    await handle.dblclick();
  } finally {
    expect(await api(page, "DELETE", dir)).toBe(204);
  }
});
