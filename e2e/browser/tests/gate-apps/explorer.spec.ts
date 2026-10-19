import type { FrameLocator, Page, Request, Response } from "@playwright/test";
import { expect, test } from "../support/chat.js";
import { RUN_TIMEOUT_MS } from "../support/constants.js";
import { FAKE_MODEL, longAnswer, pageApi } from "../support/gate5.js";

/**
 * The Kobe Explorer Gate (KOBE-441, spec §11): an MCP App in the conversation first, then from the
 * rail, in a real Chromium against a deployment (e2e/gate-apps.sh; the coordinator's runbook for
 * the gate install). One spec drives both runs:
 *
 * - k3d (`KOBE_FAKE_MODEL=1`): the fake MCP server's `ui://e2e/explorer` test app and the scripted
 *   model, which calls the opening tool when told `tool: <name> <json>` and echoes its prompt;
 * - the gate install: Catalyst's Lakehouse Explorer and a real model.
 *
 * The app and its path come from the environment (the repository is public; nothing here names a
 * host): `KOBE_APPS_CONNECTOR` (the connector's name), `KOBE_APPS_OPEN` (the prompt that makes the
 * model call the opening tool), `KOBE_APPS_PATH` (the tree items to click, comma separated, the
 * last one a table), `KOBE_APPS_USE_TEXT` (what "Use in chat" inserts), `KOBE_APPS_PROBES=1` (the
 * test app's probe buttons, k3d only) and `KOBE_APPS_SECRET` (a credential that must appear in no
 * response the browser sees).
 */
const CONNECTOR = process.env["KOBE_APPS_CONNECTOR"] ?? "e2e-apps";
const OPEN =
  process.env["KOBE_APPS_OPEN"] ??
  (FAKE_MODEL
    ? 'tool: mcp__e2e_apps__open_explorer {"depth":"5"}'
    : "Open the lakehouse explorer.");
const PATH = (process.env["KOBE_APPS_PATH"] ?? "c,c.n,c.n.t").split(",").map((s) => s.trim());
const USE_TEXT = process.env["KOBE_APPS_USE_TEXT"] ?? "Use table `c.n.t`";
const PROBES = process.env["KOBE_APPS_PROBES"] === "1";
/** The ARIA role of a tree item to click in the app (the test app: button; Catalyst: see the runbook). */
const ITEM_ROLE = (process.env["KOBE_APPS_ITEM_ROLE"] ?? "button") as
  "button" | "treeitem" | "link";
/** The app's "Use in chat" control. */
const USE_LABEL = process.env["KOBE_APPS_USE_LABEL"] ?? "Use in chat";
const SECRET = process.env["KOBE_APPS_SECRET"] ?? "";

interface App {
  readonly appId: string;
  readonly connectorName: string;
  readonly title: string;
}

/**
 * Everything the browser received from Kobe in this file's earlier tests (for the key check; one
 * worker runs the file in order, KOBE_WORKERS=1, the config's default).
 */
const bodies: string[] = [];

function record(page: Page): { calls: () => number; posts: () => string[] } {
  const calls: Request[] = [];
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/v1\/team\/apps\/[0-9a-f]{64}\/calls$/.test(r.url())) {
      calls.push(r);
    }
    if (r.method() === "POST" && /\/v1\/threads\/[^/]+\/messages$/.test(r.url())) {
      posts.push(r.postData() ?? "");
    }
  });
  page.on("response", (r: Response) => {
    if (!new URL(r.url()).pathname.startsWith("/v1/")) return;
    void r
      .text()
      .then((t) => bodies.push(t))
      .catch(() => undefined);
  });
  return { calls: () => calls.length, posts: () => posts };
}

async function theApp(page: Page): Promise<App> {
  const listed = await pageApi<{ apps?: App[] }>(page, "GET", "/v1/team/apps");
  const app = (listed.json.apps ?? []).find((a) => a.connectorName === CONNECTOR);
  expect(app, `the member has the ${CONNECTOR} app (GET /v1/team/apps)`).toBeDefined();
  return app as App;
}

/** The app's frame inside the conversation (the card's), by its host-drawn title. */
function frameOf(page: Page, app: App): FrameLocator {
  return page
    .locator('[data-kobe-scroll="messages"]')
    .frameLocator(`iframe[title="${app.title} (app from ${app.connectorName})"]`)
    .first();
}

async function entriesText(page: Page, threadId: string): Promise<string> {
  const thread = await pageApi<{ entries?: unknown[] }>(page, "GET", `/v1/threads/${threadId}`);
  return JSON.stringify(thread.json.entries ?? []);
}

test("in the conversation: the app renders, calls once, gives a chip, inserts without sending; the send is fenced; reload and Expand", async ({
  chat,
  page,
}) => {
  const seen = record(page);
  await chat.open();
  const app = await theApp(page);
  const threadId = await chat.ask(OPEN);

  // The model's call renders the app in its tool card (MA10).
  const frame = frameOf(page, app);
  const first = frame.getByRole(ITEM_ROLE, { name: PATH[0] ?? "", exact: true });
  await expect(first).toBeVisible({ timeout: RUN_TIMEOUT_MS });
  const results = await pageApi<{ results?: { tool_call_id: string | null; view: string }[] }>(
    page,
    "GET",
    `/v1/threads/${threadId}/app-results`,
  );
  expect(
    (results.json.results ?? []).some((r) => r.tool_call_id !== null && r.view === "app"),
    "the tool card has its app (the claim matched what Pi sent)",
  ).toBe(true);

  // Expanding a node makes app calls through Kobe (k3d: exactly one).
  const before = seen.calls();
  await first.click();
  await expect.poll(() => seen.calls()).toBeGreaterThan(before);
  if (FAKE_MODEL) expect(seen.calls() - before).toBe(1);

  // Down to the table: the chip shows.
  for (const name of PATH.slice(1)) {
    await frame.getByRole(ITEM_ROLE, { name, exact: true }).click();
  }
  await expect(page.getByText(new RegExp(`^Context from ${app.title}:`))).toBeVisible();

  // "Use in chat" inserts the text, marked, and sends nothing.
  const posted = seen.posts().length;
  await frame.getByRole("button", { name: USE_LABEL }).click();
  await expect(chat.composer).toHaveValue(USE_TEXT);
  await expect(page.locator("[data-kobe-app-insert-from]")).toBeVisible();
  await page.waitForTimeout(1_000);
  expect(seen.posts().length).toBe(posted);

  // The member confirms and sends: the run's prompt carries the fenced, untrusted block.
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await chat.composer.press("Enter");
  await chat.waitForIdle();
  expect(seen.posts().at(-1) ?? "").toContain('"app_context"');
  await expect
    .poll(() => entriesText(page, threadId), { timeout: RUN_TIMEOUT_MS })
    .toContain(`<app-context source=\\"connector:${app.connectorName}\\" untrusted=\\"true\\">`);
  if (FAKE_MODEL) await expect(chat.answers.last()).toContainText("app-context");

  // A reload rebuilds the app from the stored result: no app call at all.
  const beforeReload = seen.calls();
  await page.reload();
  await expect(
    frameOf(page, app).getByRole(ITEM_ROLE, { name: PATH[0] ?? "", exact: true }),
  ).toBeVisible({
    timeout: RUN_TIMEOUT_MS,
  });
  await page.waitForTimeout(2_000);
  expect(seen.calls()).toBe(beforeReload);

  // Expand moves the frame into the artifact column, and closing the tab brings it back.
  await page.getByRole("button", { name: "Expand", exact: true }).first().click();
  await expect(page.getByText("Opened in the side column").first()).toBeVisible();
  await page
    .getByRole("button", { name: `Close ${app.title}` })
    .first()
    .click();
  await expect(
    frameOf(page, app).getByRole(ITEM_ROLE, { name: PATH[0] ?? "", exact: true }),
  ).toBeVisible();
});

test("inside the app: a fetch out, ui/open-link and the write tool all fail", async ({
  chat,
  page,
}) => {
  test.skip(!PROBES, "the test app's probes (k3d, KOBE_APPS_PROBES=1)");
  await chat.open();
  const app = await theApp(page);
  await chat.ask(OPEN);
  const frame = frameOf(page, app);
  const body = frame.locator("body");
  await frame.getByRole("button", { name: "Probe fetch" }).click();
  await frame.getByRole("button", { name: "Probe open link" }).click();
  await frame.getByRole("button", { name: "Probe write" }).click();
  await expect(body).toHaveAttribute("data-probe-fetch", "blocked");
  await expect(body).toHaveAttribute("data-probe-link", /^denied:/);
  await expect(body).toHaveAttribute("data-probe-write", "denied");
});

test("from the rail: a click inserts an app card with no run; the next run sees it", async ({
  chat,
  page,
}) => {
  record(page);
  await chat.open();
  const app = await theApp(page);
  await page
    .getByRole("region", { name: "Apps" })
    .getByRole("button", { name: `Open ${app.title} in a new conversation` })
    .click();
  const threadId = await chat.threadId();
  await expect(page.locator("[data-kobe-app-card-entry]")).toBeVisible({ timeout: RUN_TIMEOUT_MS });
  await expect(
    frameOf(page, app).getByRole(ITEM_ROLE, { name: PATH[0] ?? "", exact: true }),
  ).toBeVisible({
    timeout: RUN_TIMEOUT_MS,
  });
  const runs = await pageApi<{ runs?: unknown[] }>(page, "GET", `/v1/threads/${threadId}/runs`);
  expect(runs.json.runs ?? []).toEqual([]);

  // The next question can refer to it: the model got the card's text, fenced as untrusted.
  await chat.ask(
    FAKE_MODEL
      ? "history?"
      : "Which app did I just open, and what did its first line of data say? Answer in one sentence.",
  );
  if (FAKE_MODEL) {
    await expect(chat.answers.last()).toContainText(
      `app-card source="connector:${app.connectorName}"`,
    );
    await expect(chat.answers.last()).toContainText("untrusted");
  }
  expect(
    (await pageApi<{ runs?: unknown[] }>(page, "GET", `/v1/threads/${threadId}/runs`)).json.runs,
  ).toHaveLength(1);
});

test("from the rail during a run: the launch waits as a chip and goes in after the run", async ({
  chat,
  page,
}) => {
  record(page);
  await chat.open();
  const app = await theApp(page);
  await chat.send(
    longAnswer("Write a numbered list of 40 short facts about tables, one per line."),
  );
  await chat.waitForBusy();
  await page
    .getByRole("region", { name: "Apps" })
    .getByRole("button", { name: `Open ${app.title} in this conversation` })
    .click();
  const chip = page.getByText(`App: ${app.title} (waits for the run)`);
  await expect(chip).toBeVisible();
  await chat.waitForIdle();
  await expect(chip).toHaveCount(0);
  await expect(page.locator("[data-kobe-app-card-entry]")).toBeVisible({ timeout: RUN_TIMEOUT_MS });
});

test("no credential reaches the browser or the frame", async ({ page }) => {
  test.skip(SECRET === "", "KOBE_APPS_SECRET names the credential to look for");
  expect(bodies.length).toBeGreaterThan(0);
  // Every Kobe answer of the earlier tests, the frame documents (the frame route) included.
  expect(bodies.filter((b) => b.includes(SECRET))).toEqual([]);
  expect(page).toBeDefined();
});
