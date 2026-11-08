import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./support/chat.js";
import { RUN_TIMEOUT_MS } from "./support/constants.js";
import { pageApi } from "./support/gate5.js";

/**
 * KOBE-575: the rail picker scrolls only when its content is taller than the Apps section. The
 * iframe is display block (no baseline gap under it), and when the section changes height the
 * frame fills it again instead of keeping the height the app reported before (the picker is
 * `100vh` in its frame, so it would re-report the old height). At 1440x900, then 700, then 1100,
 * the rail's scrolling section `[data-kobe-app-scroll]` has nothing to scroll. Skips without a
 * live picker (`KOBE_APPS_PICKER`, default "Lakehouse Picker") for the member.
 */
const TITLE = process.env["KOBE_APPS_PICKER"] ?? "Lakehouse Picker";

interface App {
  readonly appId: string;
  readonly title: string;
}

const appsPanel = (page: Page) => page.getByRole("tabpanel", { name: "Apps", exact: true });

/** The section's scroll height equals its visible height once the frame has settled. */
async function expectNoScroll(scroll: Locator, iframe: Locator) {
  await expect(iframe).toHaveCSS("display", "block");
  await expect
    .poll(() => scroll.evaluate((el) => el.scrollHeight - el.clientHeight), { timeout: 10_000 })
    .toBe(0);
}

/** The member's picker choice is stored server-side: leave None for the other specs. */
test.afterEach(async ({ page }) => {
  await pageApi(page, "PUT", "/v1/me/preferences", { rail_picker: null }).catch(() => undefined);
});

test("the rail picker has no scrollbar at 900, 700 and 1100 px high (KOBE-575)", async ({
  chat,
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Chromium measurement");
  await page.setViewportSize({ width: 1440, height: 900 });
  await chat.open();
  const listed = await pageApi<{ apps?: App[] }>(page, "GET", "/v1/team/apps");
  const app = (listed.json.apps ?? []).find((a) => a.title === TITLE);
  test.skip(app === undefined, `SKIPPED: no live "${TITLE}" app for this member`);
  if (!app) return;

  await chat.showBothPanels("apps");
  await appsPanel(page).getByRole("combobox", { name: "Picker" }).selectOption(app.appId);
  const iframe = appsPanel(page).locator(`iframe[title^="${TITLE}"]`);
  await expect(
    appsPanel(page).frameLocator(`iframe[title^="${TITLE}"]`).locator("body"),
  ).toBeVisible({ timeout: RUN_TIMEOUT_MS });
  const scroll = appsPanel(page).locator("[data-kobe-app-scroll]");

  await expectNoScroll(scroll, iframe);
  const tall = await scroll.evaluate((el) => el.clientHeight);
  await page.setViewportSize({ width: 1440, height: 700 });
  await expect.poll(() => scroll.evaluate((el) => el.clientHeight)).toBeLessThan(tall);
  await expectNoScroll(scroll, iframe);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await expect.poll(() => scroll.evaluate((el) => el.clientHeight)).toBeGreaterThan(tall);
  await expectNoScroll(scroll, iframe);
});
