import type { JSHandle, Page } from "@playwright/test";
import { expect, test } from "./support/chat.js";
import { RUN_TIMEOUT_MS } from "./support/constants.js";

/**
 * KOBE-551 (ac-7): a Lakehouse Picker item dragged out of its frame and dropped on the composer
 * ends exactly as a click on the picker: the backticked identifier at the caret, the table's chip,
 * and the send carries it in `references` as a clicked insert does.
 *
 * A native drag can't be started inside a cross-origin frame from a test, so the drag is the one
 * the picker starts, synthesized on the composer: a DataTransfer with the drag contract's two
 * types (`text/plain` and `application/x-catalyst-lakehouse+json`), then dragover and drop. No
 * Catalyst dependency. Chromium by default; Firefox with `KOBE_ALL_BROWSERS=1 --project firefox`.
 */
const TYPE = "application/x-catalyst-lakehouse+json";
const ITEM = {
  kind: "table",
  catalog: "mlb",
  namespace: "lahman",
  name: "batting",
  identifier: "mlb.lahman.batting",
  uri: "catalyst://lakehouse/mlb/lahman/batting",
};

function transfer(page: Page, item: unknown): Promise<JSHandle<DataTransfer>> {
  return page.evaluateHandle(
    ({ type, json, plain }) => {
      const dt = new DataTransfer();
      dt.setData("text/plain", plain);
      dt.setData(type, json);
      dt.effectAllowed = "copy";
      return dt;
    },
    { type: TYPE, json: JSON.stringify(item), plain: "`mlb.lahman.batting`" },
  );
}

const panel = (page: Page) => page.locator("[data-kobe-composer-panel]");
const chipRow = (page: Page) =>
  page.getByRole("list", { name: "Items sent with your next message" });

test("a Lakehouse Picker item dropped on the composer is the clicked insert: identifier at the caret, chip, references on send", async ({
  chat,
  page,
  browserName,
}) => {
  test.info().annotations.push({ type: "browser", description: browserName });
  await chat.open();
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/v1\/threads(\/[^/]+\/messages)?$/.test(r.url())) {
      posts.push(r.postData() ?? "");
    }
  });

  await chat.composer.fill("Count the rows in");
  const dataTransfer = await transfer(page, ITEM);
  await chat.composer.dispatchEvent("dragover", { dataTransfer });
  await expect(panel(page)).toHaveAttribute("data-mention-drop", "item");
  await expect(page.locator("#kobe-composer-hint")).toHaveText("Drop to insert this item");
  await chat.composer.dispatchEvent("drop", { dataTransfer });

  // Exactly one copy (the browser's text/plain insertion never adds a second), the caret after it.
  await expect(chat.composer).toHaveValue("Count the rows in `mlb.lahman.batting` ");
  await expect(chat.composer).toBeFocused();
  expect(
    await chat.composer.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.value.length]),
  ).toEqual([39, 39]);
  await expect(panel(page)).not.toHaveAttribute("data-mention-drop", /.+/);
  // The chip a click on the picker adds, with the table's icon.
  await expect(chipRow(page).getByRole("listitem")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Table mlb.lahman.batting, from Lakehouse Picker; remove" }),
  ).toBeVisible();
  await expect(
    page.locator('[data-kobe-app-item="table"] [data-kobe-item-icon="table"]'),
  ).toHaveCount(1);

  // An item the rules refuse: a note under the composer, nothing inserted, no text/plain fallback.
  const bad = await transfer(page, { ...ITEM, identifier: "mlb.lahman.pitching" });
  await chat.composer.dispatchEvent("dragover", { dataTransfer: bad });
  await chat.composer.dispatchEvent("drop", { dataTransfer: bad });
  await expect(page.locator("#kobe-composer-hint")).toContainText("can't go into a message");
  await expect(chat.composer).toHaveValue("Count the rows in `mlb.lahman.batting` ");
  await expect(chipRow(page).getByRole("listitem")).toHaveCount(1);

  // The send carries the item as `references`, as a clicked insert does.
  await chat.composer.press("Enter");
  await chat.threadId();
  await expect(chipRow(page)).toHaveCount(0);
  await expect.poll(() => posts.filter((p) => p.includes('"references"')).length).toBe(1);
  const body = JSON.parse(posts.find((p) => p.includes('"references"')) ?? "{}");
  expect(body).toMatchObject({
    content: "Count the rows in `mlb.lahman.batting`",
    references: [{ name: "mlb.lahman.batting", kind: "table" }],
  });
  const sent = chat.userMessages.last().getByRole("list", { name: "Referenced items" });
  await expect(sent.getByText("mlb.lahman.batting", { exact: true })).toBeVisible({
    timeout: RUN_TIMEOUT_MS,
  });
  await chat.waitForIdle();
});
