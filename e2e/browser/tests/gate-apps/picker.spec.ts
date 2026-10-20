import type { FrameLocator, Locator, Page, Request } from "@playwright/test";
import { expect, test, type Chat } from "../support/chat.js";
import { RUN_TIMEOUT_MS } from "../support/constants.js";
import { pageApi } from "../support/gate5.js";

/**
 * KOBE-460 (spec MA3 as amended 2026-10-20): a picker app live in the rail's Apps tab, in a real
 * Chromium against a deployment. The member picks it from the Pickers dropdown, chooses a table
 * in it, and the composer shows the text; nothing is sent and nothing is written to a thread. The
 * rail widens to at least 400 px while the picker shows and comes back to the member's width on
 * None; a collapsed rail and a phone's drawer still work.
 *
 * On the gate install the picker is the Catalyst connector's "Lakehouse Picker". The app and its
 * path come from the environment (the repository is public; nothing here names a host):
 * `KOBE_APPS_CONNECTOR` (the connector's name), `KOBE_APPS_PICKER` (the picker's title; default:
 * the connector's first app named "…Picker…"), `KOBE_APPS_PICKER_PATH` (the items to click, comma
 * separated, the last one a table; default `KOBE_APPS_PATH`), `KOBE_APPS_ITEM_ROLE` (their ARIA
 * role), `KOBE_APPS_PICKER_USE_LABEL` (a button to press after the table, if the picker has one)
 * and `KOBE_APPS_PICKER_TEXT` (text the composer then contains; default: the table's name).
 * Without a live picker for the member (k3d's test server has none) the file skips.
 */
const CONNECTOR_SET = (process.env["KOBE_APPS_CONNECTOR"] ?? "") !== "";
const CONNECTOR = CONNECTOR_SET ? (process.env["KOBE_APPS_CONNECTOR"] as string) : "e2e-apps";
const TITLE = process.env["KOBE_APPS_PICKER"];
const PATH = (
  process.env["KOBE_APPS_PICKER_PATH"] ??
  process.env["KOBE_APPS_PATH"] ??
  "c,c.n,c.n.t"
)
  .split(",")
  .map((s) => s.trim());
const ITEM_ROLE = (process.env["KOBE_APPS_ITEM_ROLE"] ?? "button") as
  "button" | "treeitem" | "link";
const USE_LABEL = process.env["KOBE_APPS_PICKER_USE_LABEL"] ?? "";
const TEXT = process.env["KOBE_APPS_PICKER_TEXT"] ?? PATH.at(-1) ?? "";
const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const PICKER_PX = 400;

interface App {
  readonly appId: string;
  readonly connectorName: string;
  readonly title: string;
}

async function thePicker(page: Page): Promise<App | undefined> {
  const listed = await pageApi<{ apps?: App[] }>(page, "GET", "/v1/team/apps");
  return (listed.json.apps ?? []).find(
    (a) =>
      a.connectorName === CONNECTOR &&
      (TITLE === undefined ? /picker/i.test(a.title) : a.title === TITLE),
  );
}

/** Opens the chat and finds the picker; skips the test where the member has none. */
async function openWithPicker(chat: Chat, page: Page): Promise<App> {
  await chat.open();
  const picker = await thePicker(page);
  test.skip(
    picker === undefined,
    CONNECTOR_SET
      ? `SKIPPED: no live picker app of connector "${CONNECTOR}" for this member`
      : 'SKIPPED: KOBE_APPS_CONNECTOR is not set (the default "e2e-apps" has no picker); ' +
          "set it to the connector that offers the picker (gate1: catalyst_2)",
  );
  return picker as App;
}

const appsPanel = (page: Page) => page.getByRole("tabpanel", { name: "Apps", exact: true });
const pickerSelect = (page: Page) => appsPanel(page).getByRole("combobox", { name: "Picker" });
const frameOf = (page: Page, app: App): FrameLocator =>
  appsPanel(page).frameLocator(`iframe[title="${app.title} (app from ${app.connectorName})"]`);
const railWidth = async (page: Page) =>
  (await page.locator("#kobe-workspace-rail").boundingBox())?.width ?? 0;

async function showApps(page: Page, chat: Chat): Promise<void> {
  await chat.showBothPanels("apps");
  await expect(appsPanel(page)).toBeVisible();
}

/** The member's choice is stored server-side: leave None for the other specs. */
async function pickNone(page: Page): Promise<void> {
  await pageApi(page, "PUT", "/v1/me/preferences", { rail_picker: null });
}

function watchSends(page: Page): () => number {
  const sent: Request[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/v1\/threads(\/[^/]+\/(messages|app-cards))?$/.test(r.url())) {
      sent.push(r);
    }
  });
  return () => sent.length;
}

async function choose(page: Page, app: App): Promise<FrameLocator> {
  await pickerSelect(page).selectOption(app.appId);
  const frame = frameOf(page, app);
  await expect(frame.getByRole(ITEM_ROLE, { name: PATH[0] ?? "", exact: true })).toBeVisible({
    timeout: RUN_TIMEOUT_MS,
  });
  return frame;
}

async function pickTable(frame: FrameLocator): Promise<void> {
  for (const name of PATH) await frame.getByRole(ITEM_ROLE, { name, exact: true }).click();
  if (USE_LABEL !== "") await frame.getByRole("button", { name: USE_LABEL }).click();
}

async function noPageScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }));
  expect(overflow).toEqual({ x: 0, y: 0 });
}

test.afterEach(async ({ page }) => {
  await pickNone(page).catch(() => undefined);
});

test("pick the picker, choose a table: the composer shows the text and nothing is sent", async ({
  chat,
  page,
}) => {
  await page.setViewportSize(WIDE);
  const app = await openWithPicker(chat, page);
  const sends = watchSends(page);
  await showApps(page, chat);
  const own = await railWidth(page);
  // The list below still lists every app, the picker too.
  await expect(appsPanel(page).getByTitle(new RegExp(`^Open ${app.title} from `))).toBeVisible();

  const frame = await choose(page, app);
  await expect.poll(() => railWidth(page)).toBeGreaterThanOrEqual(Math.max(own, PICKER_PX) - 1);
  await noPageScroll(page);
  await pickTable(frame);
  await expect(chat.composer).toHaveValue(new RegExp(TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await expect(page.locator("[data-kobe-app-insert-from]")).toContainText(`From ${app.title}`);
  await page.waitForTimeout(1_000);
  expect(sends(), "no thread was created and nothing was sent").toBe(0);

  // None: the frame goes and the member's own width comes back.
  await pickerSelect(page).selectOption("");
  await expect(appsPanel(page).locator("iframe")).toHaveCount(0);
  await expect.poll(() => railWidth(page)).toBeLessThanOrEqual(own + 1);
});

test("the choice is kept; a collapsed rail keeps the picker and widens again when expanded", async ({
  chat,
  page,
}) => {
  await page.setViewportSize(WIDE);
  const app = await openWithPicker(chat, page);
  await showApps(page, chat);
  await choose(page, app);
  await page.reload();
  await expect(chat.composer).toBeVisible({ timeout: RUN_TIMEOUT_MS });
  await expect(pickerSelect(page)).toHaveValue(app.appId);
  await expect(
    frameOf(page, app).getByRole(ITEM_ROLE, { name: PATH[0] ?? "", exact: true }),
  ).toBeVisible({ timeout: RUN_TIMEOUT_MS });

  await chat.railHeader.getByRole("button", { name: "Collapse the rail" }).click();
  await expect.poll(() => railWidth(page)).toBeLessThan(100);
  await page.getByRole("button", { name: "Show apps" }).click();
  await expect(appsPanel(page)).toBeVisible();
  await expect.poll(() => railWidth(page)).toBeGreaterThanOrEqual(PICKER_PX - 1);
  await expect(
    frameOf(page, app).getByRole(ITEM_ROLE, { name: PATH[0] ?? "", exact: true }),
  ).toBeVisible();
});

test("a phone: the picker runs in the drawer and fills the draft; no page scroll", async ({
  chat,
  page,
}) => {
  const app = await openWithPicker(chat, page);
  await page.setViewportSize(PHONE);
  await page.getByRole("button", { name: "Show the workspace" }).click();
  const drawer: Locator = page.getByRole("dialog", { name: "Workspace" });
  await expect(drawer).toBeVisible();
  const tab = drawer.getByRole("tab", { name: "Apps", exact: true });
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  const frame = await choose(page, app);
  const box = await drawer.boundingBox();
  expect(box?.width ?? 0).toBeLessThanOrEqual(PHONE.width);
  await noPageScroll(page);
  await pickTable(frame);
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(chat.composer).toHaveValue(new RegExp(TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
