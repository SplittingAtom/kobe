import type { FrameLocator, Page } from "@playwright/test";
import { expect, test } from "./support/chat.js";
import { RUN_TIMEOUT_MS } from "./support/constants.js";
import { pageApi } from "./support/gate5.js";

/**
 * KOBE-490 (ac-1..ac-4, ac-5's browser spec): an MCP App's `ui/message` with resource_links puts
 * typed chips in the composer's chip row of the card's thread, instead of the message's text; the
 * member removes one, types a question and sends; the request carries the chips still shown as
 * `references`, the sent message shows them as chips under its text, also after a reload.
 *
 * The app is the fake MCP server's test explorer (e2e/lib/fake-mcp.js, FAKE_MCP_APPS=1, the
 * `e2e-apps` connector of e2e/gate-apps.sh): its "Use as item" sends the chosen table and its
 * namespace as resource_links. No Catalyst dependency. Without that app for the member the file
 * skips (`KOBE_APPS_CONNECTOR` names another connector whose app has the same button).
 */
const CONNECTOR = process.env["KOBE_APPS_CONNECTOR"] ?? "e2e-apps";
const PATH = ["c", "c.n", "c.n.t"];

interface App {
  readonly appId: string;
  readonly connectorName: string;
  readonly title: string;
}

async function theApp(page: Page): Promise<App | undefined> {
  const listed = await pageApi<{ apps?: App[] }>(page, "GET", "/v1/team/apps");
  return (listed.json.apps ?? []).find((a) => a.connectorName === CONNECTOR);
}

function frameOf(page: Page, app: App): FrameLocator {
  return page
    .locator('[data-kobe-scroll="messages"]')
    .frameLocator(`iframe[title="${app.title} (app from ${app.connectorName})"]`)
    .first();
}

async function launch(page: Page, app: App): Promise<void> {
  const tab = page
    .getByRole("tablist", { name: "Files and apps" })
    .getByRole("tab", { name: "Apps", exact: true });
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  await page
    .getByRole("tabpanel", { name: "Apps", exact: true })
    .getByTitle(`Open ${app.title} from ${app.connectorName} in a new conversation`, {
      exact: true,
    })
    .click();
}

const chipRow = (page: Page) =>
  page.getByRole("list", { name: "Items sent with your next message" });

test("an app's resource_links become typed chips; the send carries them and the message shows them after reload", async ({
  chat,
  page,
}) => {
  await chat.open();
  const app = await theApp(page);
  test.skip(app === undefined, `SKIPPED: no app of connector "${CONNECTOR}" for this member`);
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/v1\/threads\/[^/]+\/messages$/.test(r.url())) {
      posts.push(r.postData() ?? "");
    }
  });

  await launch(page, app as App);
  await chat.threadId();
  const frame = frameOf(page, app as App);
  for (const name of PATH) {
    await frame.getByRole("button", { name, exact: true }).click({ timeout: RUN_TIMEOUT_MS });
  }
  await frame.getByRole("button", { name: "Use as item" }).click();

  // Two chips, each with its kind's icon and an accessible name; no text went in; nothing sent.
  await expect(chipRow(page).getByRole("listitem")).toHaveCount(2);
  const tableChip = page.getByRole("button", {
    name: `Table c.n.t, from ${(app as App).title}; remove`,
  });
  await expect(tableChip).toBeVisible();
  await expect(
    page.locator('[data-kobe-app-item="table"] [data-kobe-item-icon="table"]'),
  ).toHaveCount(1);
  await expect(chat.composer).toHaveValue("");
  await expect(frame.locator("body")).toHaveAttribute("data-item", "ok");
  // The same items again: still two chips (de-duplicated by uri).
  await frame.getByRole("button", { name: "Use as item" }).click();
  await expect(chipRow(page).getByRole("listitem")).toHaveCount(2);
  expect(posts).toHaveLength(0);

  // The member removes the namespace chip with the keyboard and sends a question.
  const nsChip = page.getByRole("button", {
    name: `Namespace c.n, from ${(app as App).title}; remove`,
  });
  await nsChip.focus();
  await page.keyboard.press("Delete");
  await expect(chipRow(page).getByRole("listitem")).toHaveCount(1);
  await chat.send("How many rows?");
  await expect(chipRow(page)).toHaveCount(0);
  await expect.poll(() => posts.length).toBe(1);
  expect(JSON.parse(posts[0] ?? "{}")).toMatchObject({
    content: "How many rows?",
    references: [{ name: "c.n.t", kind: "table" }],
  });

  // The sent message shows the chip under its text, also after a reload.
  const sent = () => chat.userMessages.last().getByRole("list", { name: "Referenced items" });
  await expect(sent().getByText("c.n.t", { exact: true })).toBeVisible({ timeout: RUN_TIMEOUT_MS });
  await chat.waitForIdle();
  await page.reload();
  await expect(sent().getByText("c.n.t", { exact: true })).toBeVisible({ timeout: RUN_TIMEOUT_MS });
  await expect(chat.userMessages.last()).toContainText("How many rows?");
  await expect(chat.userMessages.last()).not.toContainText("Referenced:");
});
