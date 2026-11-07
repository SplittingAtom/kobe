import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./support/chat.js";
import { RUN_TIMEOUT_MS } from "./support/constants.js";
import { FRAME_GUARD, fetchReal } from "./support/frame-route.js";
import { pageApi } from "./support/gate5.js";

/**
 * KOBE-553 (ac-7, DRAG-CONTRACT.md): a real pointer drag from a Lakehouse Picker row inside the
 * rail frame to the composer. Chromium refuses native drags between cross-origin frames
 * (crbug.com/59081), so the picker drives the drag with captured pointer events and tells Kobe
 * over the bridge; Kobe draws the ghost chip, lights the composer while the pointer is over it,
 * and on release adds exactly the click's chip (from "Lakehouse Picker"), no text, and the send
 * carries it in `references`.
 *
 * The drag is real input (`page.mouse` down, moves in steps, up); a Playwright `dragTo` would
 * start a native drag, which the picker no longer uses. It needs the picker build that speaks
 * the contract (Catalyst CAT-247). Until that build is deployed and re-pinned, set
 * `KOBE_PICKER_HTML=<path to the built picker html>`: the frame route is intercepted as in
 * `app-frame.spec.ts` (the real response's status, headers and WebRTC guard script kept), and
 * only the template bytes are replaced by that file. `KOBE_APPS_PICKER` names the picker
 * (default "Lakehouse Picker"); without it live for the member the spec skips. Chromium by
 * default; Firefox with `KOBE_ALL_BROWSERS=1 --project firefox`.
 */
const TITLE = process.env["KOBE_APPS_PICKER"] ?? "Lakehouse Picker";
const PICKER_HTML = process.env["KOBE_PICKER_HTML"] ?? "";

interface App {
  readonly appId: string;
  readonly title: string;
  readonly placement?: string;
}

const appsPanel = (page: Page) => page.getByRole("tabpanel", { name: "Apps", exact: true });
const panel = (page: Page) => page.locator("[data-kobe-composer-panel]");
const hint = (page: Page) => page.locator("#kobe-composer-hint");
const ghost = (page: Page) => page.locator("[data-kobe-frame-drag-ghost]");
const chipRow = (page: Page) =>
  page.getByRole("list", { name: "Items sent with your next message" });

/** The new picker build in place of the deployed template, after the deployment's own guard. */
function pickerBody(realBody: string, html: string): string {
  const guard = FRAME_GUARD.exec(realBody)?.[0];
  expect(guard, "the frame document starts with Kobe's WebRTC guard").toBeDefined();
  const doctype = /<!doctype html>/i.exec(html);
  if (!doctype) return `<!doctype html>${guard ?? ""}${html}`;
  const at = doctype.index + doctype[0].length;
  return `${html.slice(0, at)}${guard ?? ""}${html.slice(at)}`;
}

async function servePickerBuild(page: Page): Promise<void> {
  if (PICKER_HTML === "") return;
  const html = readFileSync(PICKER_HTML, "utf8");
  await page.route("**/v1/team/apps/*/frame*", async (route) => {
    const real = await fetchReal(route);
    if (real.status !== 200) {
      await route.fulfill({ status: real.status, headers: real.headers, body: real.body });
      return;
    }
    await route.fulfill({
      status: real.status,
      headers: real.headers,
      body: pickerBody(real.body, html),
    });
  });
}

function centre(box: { x: number; y: number; width: number; height: number } | null) {
  expect(box).not.toBeNull();
  const b = box ?? { x: 0, y: 0, width: 0, height: 0 };
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** The member's picker choice is stored server-side: leave None for the other specs. */
test.afterEach(async ({ page }) => {
  await pageApi(page, "PUT", "/v1/me/preferences", { rail_picker: null }).catch(() => undefined);
});

test("a picker row dragged with the pointer onto the composer adds the click's chip; the send carries it", async ({
  chat,
  page,
  browserName,
}) => {
  test.info().annotations.push({ type: "browser", description: browserName });
  await page.setViewportSize({ width: 1440, height: 900 });
  await servePickerBuild(page);
  await chat.open();
  const listed = await pageApi<{ apps?: App[] }>(page, "GET", "/v1/team/apps");
  const app = (listed.json.apps ?? []).find((a) => a.title === TITLE);
  test.skip(app === undefined, `SKIPPED: no live "${TITLE}" app for this member`);
  if (!app) return;

  await chat.showBothPanels("apps");
  await appsPanel(page).getByRole("combobox", { name: "Picker" }).selectOption(app.appId);
  const frame = appsPanel(page).frameLocator(`iframe[title^="${TITLE}"]`);
  const row: Locator = frame.locator("button.pick").first();
  await expect(row).toBeVisible({ timeout: RUN_TIMEOUT_MS });

  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/v1\/threads(\/[^/]+\/messages)?$/.test(r.url())) {
      posts.push(r.postData() ?? "");
    }
  });
  await chat.composer.fill("Count the rows in");

  // Press on the row, pass the 6 px threshold, then travel to the composer's centre.
  const start = centre(await row.boundingBox());
  const target = centre(await panel(page).boundingBox());
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 12, start.y + 4, { steps: 4 });
  await expect(ghost(page)).toBeVisible();
  await expect(ghost(page)).toHaveAttribute("aria-hidden", "true");
  // The ghost shows the item's identifier (its kind is an icon and a hidden label).
  const identifier = (await ghost(page).locator("span[title]").getAttribute("title")) ?? "";
  expect(identifier).not.toBe("");
  // Not yet over the composer: no cue.
  await expect(panel(page)).not.toHaveAttribute("data-mention-drop", /.+/);

  await page.mouse.move(target.x, target.y, { steps: 25 });
  await expect(ghost(page)).toBeVisible();
  await expect(panel(page)).toHaveAttribute("data-mention-drop", "item");
  await expect(hint(page)).toHaveText("Drop to insert this item");
  await page.mouse.up();

  await expect(ghost(page)).toHaveCount(0);
  await expect(panel(page)).not.toHaveAttribute("data-mention-drop", /.+/);
  await expect(chipRow(page).getByRole("listitem")).toHaveCount(1);
  const chip = chipRow(page).getByRole("button", { name: /, from Lakehouse Picker; remove$/ });
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveAccessibleName(new RegExp(` ${identifier.replace(/\./g, "\\.")},`));
  // No text from the drag: the member's text stays as it was.
  await expect(chat.composer).toHaveValue("Count the rows in");

  // After a captured drag the keyboard focus is still in the picker's frame (Firefox keeps it
  // there until the page is clicked), so send the way a member does: click the box, then Enter.
  await chat.composer.click();
  await chat.composer.press("Enter");
  await chat.threadId();
  await expect(chipRow(page)).toHaveCount(0);
  await expect.poll(() => posts.filter((p) => p.includes('"references"')).length).toBe(1);
  const body = JSON.parse(posts.find((p) => p.includes('"references"')) ?? "{}");
  expect(body).toMatchObject({
    content: "Count the rows in",
    references: [{ name: identifier }],
  });
  await chat.waitForIdle();
});
