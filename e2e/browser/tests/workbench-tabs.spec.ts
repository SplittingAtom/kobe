import { expect, test, type Page } from "@playwright/test";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";
import { panelOf } from "./support/panel.js";

/**
 * KOBE-459: the Workbench draft page's Define, Test and Eval tabs against a real deployment. The
 * header and the draft settings stay above the tabs; the tab is in the address and remembered for
 * the draft; Define's editor rail resizes by keys and by dragging, and the width comes back after a
 * reload; at phone width the tabs fit and the tree stacks above the rail. Starts one draft and
 * deletes it at the end; no model turn and no eval run. Run on gate1:
 * `npx playwright test workbench-tabs`.
 */
const NAME = `e2e-tabs-${Date.now().toString(36)}`;
const PHONE = { width: 390, height: 844 } as const;

const tabs = (page: Page) => panelOf(page).getByRole("tablist", { name: "Draft" });
const handle = (page: Page) => panelOf(page).getByRole("separator", { name: "Resize the editor" });
const width = async (page: Page) => Number(await handle(page).getAttribute("aria-valuenow"));

test("a draft's Define, Test and Eval tabs, the resizable editor rail and phone width", async ({
  page,
}) => {
  await page.goto("/me/skills?tab=workbench");
  await panelOf(page).getByLabel("Skill name").fill(NAME);
  await panelOf(page).getByRole("button", { name: "Start a draft" }).click();
  await expect(panelOf(page).getByRole("heading", { level: 1, name: NAME })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  const draftUrl = new URL(page.url());

  // ac-1: the tablist, Define first; the header and settings above it.
  await expect(tabs(page).getByRole("tab")).toHaveText(["Define", "Test", "Eval"]);
  await expect(tabs(page).getByRole("tab", { name: "Define", selected: true })).toBeVisible();
  await expect(page).toHaveURL(/[?&]tab=define\b/);
  await expect(panelOf(page).getByRole("button", { name: "Save version" })).toBeVisible();

  // ac-2/3: the rail takes most of the width and resizes by keys and by dragging.
  const define = panelOf(page).getByRole("tabpanel", { name: "Define" });
  await expect(define.getByLabel("Description")).toBeVisible();
  const start = await width(page);
  const tree = await define.getByRole("navigation", { name: "Files" }).boundingBox();
  expect(start).toBeGreaterThan(tree?.width ?? 0);
  await handle(page).focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => width(page)).toBe(start + 24);
  const box = await handle(page).boundingBox();
  if (!box) throw new Error("no resize handle");
  const y = box.y + 40;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, y, { steps: 5 });
  await page.mouse.up();
  const dragged = await width(page);
  expect(Math.abs(dragged - (start + 24 - 60))).toBeLessThanOrEqual(2);

  // ac-4/5: Test and Eval, each in the address.
  await tabs(page).getByRole("tab", { name: "Test" }).click();
  await expect(page).toHaveURL(/[?&]tab=test\b/);
  await expect(panelOf(page).getByRole("heading", { name: "Test", level: 2 })).toBeVisible();
  await tabs(page).getByRole("tab", { name: "Eval" }).click();
  await expect(page).toHaveURL(/[?&]tab=eval\b/);
  await expect(panelOf(page).getByRole("heading", { name: "Evals", level: 2 })).toBeVisible();

  // ac-6: a reload opens the last tab, and the dragged width comes back (saved per member).
  draftUrl.search = "";
  await page.goto(draftUrl.toString());
  await expect(tabs(page).getByRole("tab", { name: "Eval", selected: true })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await page.goto(`${draftUrl.toString()}?tab=nonsense`);
  await expect(tabs(page).getByRole("tab", { name: "Define", selected: true })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await expect.poll(() => width(page)).toBe(dragged);
  await handle(page).dblclick();
  await expect.poll(() => width(page)).toBe(start);

  // ac-7: phone width, light and dark: the tabs fit, nothing scrolls sideways, the tree on top.
  await page.setViewportSize(PHONE);
  await expect(handle(page)).toBeHidden();
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    const sideways = await page.evaluate(
      () => (document.scrollingElement?.scrollWidth ?? 0) - window.innerWidth,
    );
    expect(sideways).toBeLessThanOrEqual(0);
    // The three tabs fit on the line: the list neither overflows nor leaves the window.
    const fits = await tabs(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
    expect(fits).toBe(true);
    const list = await tabs(page).boundingBox();
    expect((list?.x ?? 0) + (list?.width ?? 0)).toBeLessThanOrEqual(PHONE.width);
    await test.info().attach(`workbench-tabs-phone-${theme}.png`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  }
  await page.evaluate(() => delete document.documentElement.dataset.theme);
  const treeBox = await define.getByRole("navigation", { name: "Files" }).boundingBox();
  const formBox = await define.getByLabel("Description").boundingBox();
  expect(treeBox?.y ?? 0).toBeLessThan(formBox?.y ?? 0);

  await page.setViewportSize({ width: 1280, height: 800 });
  await panelOf(page).getByRole("button", { name: "Delete draft" }).click();
  await page
    .getByRole("alertdialog", { name: `Delete the draft ${NAME}?` })
    .getByRole("button", { name: "Delete draft" })
    .click();
  await expect(page).toHaveURL(/\/me\/skills\?tab=workbench$/);
});
