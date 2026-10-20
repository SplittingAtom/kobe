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

/**
 * The rail's button for this app: by its tooltip, which names the connector (two connectors may
 * offer apps with the same title, as on k3d).
 */
function railButton(page: Page, app: App, where: "this conversation" | "a new conversation") {
  return page
    .getByRole("tabpanel", { name: "Apps", exact: true })
    .getByTitle(`Open ${app.title} from ${app.connectorName} in ${where}`, { exact: true });
}

/** The rail's Apps tab (KOBE-448: Files | Apps), chosen; the member's choice is kept. */
async function showAppsTab(page: Page): Promise<void> {
  const tab = page
    .getByRole("tablist", { name: "Files and apps" })
    .getByRole("tab", { name: "Apps", exact: true });
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
}

/** The app's frame inside the conversation (the card's), by its host-drawn title. */
function frameOf(page: Page, app: App): FrameLocator {
  return page
    .locator('[data-kobe-scroll="messages"]')
    .frameLocator(`iframe[title="${app.title} (app from ${app.connectorName})"]`)
    .first();
}

/**
 * Every run of the thread: `GET …/runs` lists only the active and queued ones (a finished run
 * leaves it, which is why counting it after an answer gave 0), `GET …/feedback` the ended ones.
 */
async function everyRun(
  page: Page,
  threadId: string,
): Promise<{ active: string[]; ended: string[] }> {
  const live = await pageApi<{ runs?: { run_id: string }[] }>(
    page,
    "GET",
    `/v1/threads/${threadId}/runs`,
  );
  const ended = await pageApi<{ answers?: { run_id: string }[] }>(
    page,
    "GET",
    `/v1/threads/${threadId}/feedback`,
  );
  expect([live.status, ended.status]).toEqual([200, 200]);
  return {
    active: (live.json.runs ?? []).map((r) => r.run_id),
    ended: (ended.json.answers ?? []).map((r) => r.run_id),
  };
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

  // k3d: a long answer puts the card well above the fold, as the real model's answers did on the
  // gate install (KOBE-445: the reload opens at the bottom, and the card waited for a scroll).
  if (FAKE_MODEL) await chat.ask(longAnswer(""));

  // A reload rebuilds the app from the stored result: no app call at all. The thread opens at
  // its end; the member scrolls up to the card, which loads as it comes near.
  const beforeReload = seen.calls();
  await page.reload();
  const card = page.locator("[data-kobe-app-card]").first();
  await expect(card).toBeAttached({ timeout: RUN_TIMEOUT_MS });
  await card.scrollIntoViewIfNeeded();
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
  await showAppsTab(page);
  await railButton(page, app, "a new conversation").click();
  const threadId = await chat.threadId();
  await expect(page.locator("[data-kobe-app-card-entry]")).toBeVisible({ timeout: RUN_TIMEOUT_MS });
  await expect(
    frameOf(page, app).getByRole(ITEM_ROLE, { name: PATH[0] ?? "", exact: true }),
  ).toBeVisible({
    timeout: RUN_TIMEOUT_MS,
  });
  // No run at all: none active or queued, and none ended (the launch is not a turn).
  const launched = await everyRun(page, threadId);
  expect(launched, JSON.stringify(launched)).toEqual({ active: [], ended: [] });

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
  // Exactly one run in the thread's life: the question's (the launch made none), ended.
  await expect
    .poll(async () => JSON.stringify(await everyRun(page, threadId)), { timeout: RUN_TIMEOUT_MS })
    .toMatch(/^\{"active":\[\],"ended":\["[0-9a-f-]{36}"\]\}$/);
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
  await showAppsTab(page);
  await railButton(page, app, "this conversation").click();
  const chip = page.getByText(`App: ${app.title} (waits for the run)`);
  await expect(chip).toBeVisible();
  await chat.waitForIdle();
  await expect(chip).toHaveCount(0);
  await expect(page.locator("[data-kobe-app-card-entry]")).toBeVisible({ timeout: RUN_TIMEOUT_MS });
});

test("no credential reaches the browser or the frame", async ({ chat, page }) => {
  test.skip(SECRET === "", "KOBE_APPS_SECRET names the credential to look for");
  // Every answer from Kobe while the app opens from the rail and renders, frame document included.
  const seen: string[] = [];
  page.on("response", (r: Response) => {
    if (!new URL(r.url()).pathname.startsWith("/v1/")) return;
    void r
      .text()
      .then((t) => seen.push(t))
      .catch(() => undefined);
  });
  await chat.open();
  const app = await theApp(page);
  await showAppsTab(page);
  await railButton(page, app, "a new conversation").click();
  await chat.threadId();
  const frame = frameOf(page, app);
  await expect(frame.getByRole(ITEM_ROLE, { name: PATH[0] ?? "", exact: true })).toBeVisible({
    timeout: RUN_TIMEOUT_MS,
  });
  await frame.getByRole(ITEM_ROLE, { name: PATH[0] ?? "", exact: true }).click();
  await page.waitForTimeout(2_000);
  expect(
    seen.some((b) => /<!doctype html>/i.test(b)),
    "the frame document was seen",
  ).toBe(true);
  expect(seen.filter((b) => b.includes(SECRET))).toEqual([]);
  expect(bodies.filter((b) => b.includes(SECRET))).toEqual([]);
});
