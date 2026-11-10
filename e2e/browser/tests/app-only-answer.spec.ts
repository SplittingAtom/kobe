import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./support/chat.js";
import { RUN_TIMEOUT_MS } from "./support/constants.js";
import { FAKE_MODEL, pageApi } from "./support/gate5.js";

/**
 * KOBE-608 ac-4: an answer whose tool call renders an MCP App shows only the app card(s); the rest
 * of the answer (prose, reasoning, other tool cards) is behind a collapsed "Show response" under
 * them, live and after a reload.
 *
 * The app comes from the environment, as in `gate-apps/explorer.spec.ts` (nothing here names a
 * host): `KOBE_APPS_CONNECTOR` (the connector's name) and `KOBE_APPS_OPEN` (the prompt that makes
 * the model call the app's opening tool). Without the connector's app the spec skips, unless
 * `KOBE_REQUIRE_APP=1`. One model run; it leaves a thread behind.
 */
const CONNECTOR = process.env["KOBE_APPS_CONNECTOR"] ?? "e2e-apps";
const OPEN =
  process.env["KOBE_APPS_OPEN"] ??
  (FAKE_MODEL
    ? 'tool: mcp__e2e_apps__open_explorer {"depth":"5"}'
    : "In one sentence say what you will do, then open the lakehouse explorer, then say in one sentence what it shows.");

interface App {
  readonly connectorName: string;
  readonly title: string;
}

async function theApp(page: Page): Promise<App | undefined> {
  const listed = await pageApi<{ apps?: App[] }>(page, "GET", "/v1/team/apps");
  expect(listed.status).toBe(200);
  return (listed.json.apps ?? []).find((a) => a.connectorName === CONNECTOR);
}

/** The answer with the app's frame. */
function appAnswer(page: Page, app: App): Locator {
  const frame = `iframe[title="${app.title} (app from ${app.connectorName})"]`;
  return page.locator('[data-role="assistant"]', { has: page.locator(frame) }).last();
}

/** Only app cards show: every visible tool card holds an app; the toggle, if any, is closed. */
async function onlyTheApp(answer: Locator): Promise<Locator> {
  const cards = answer.locator('section[aria-label^="Tool call"]');
  const apps = answer.locator('section[aria-label^="Tool call"]:has([data-kobe-app-card])');
  await expect(apps.first()).toBeVisible({ timeout: RUN_TIMEOUT_MS });
  expect(await cards.count()).toBe(await apps.count());
  const toggle = answer.getByRole("button", { name: "Show response" });
  if ((await toggle.count()) > 0) await expect(toggle).toHaveAttribute("aria-expanded", "false");
  return toggle;
}

test("an answer with an MCP app shows only the app; Show response reveals the rest", async ({
  chat,
  page,
}) => {
  await chat.open();
  const app = await theApp(page);
  if (process.env["KOBE_REQUIRE_APP"] === "1") {
    expect(app, `KOBE_REQUIRE_APP=1: the member needs the ${CONNECTOR} app`).toBeDefined();
  }
  test.skip(app === undefined, `${CONNECTOR} has no app for this member in the active team.`);
  if (!app) return;

  await chat.ask(OPEN);
  const answer = appAnswer(page, app);
  const toggle = await onlyTheApp(answer);
  const shown = (await answer.innerText()).length;
  if ((await toggle.count()) > 0) {
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect.poll(async () => (await answer.innerText()).length).toBeGreaterThan(shown);
    // The app stays one frame in its card.
    await expect(answer.locator("iframe")).toHaveCount(
      await answer.locator("[data-kobe-app-card] iframe").count(),
    );
  } else {
    test
      .info()
      .annotations.push({ type: "note", description: "the answer had nothing besides the app" });
  }

  // After a reload: the same, the toggle closed again.
  await page.reload();
  const card = page.locator("[data-kobe-app-card]").last();
  await expect(card).toBeAttached({ timeout: RUN_TIMEOUT_MS });
  await card.scrollIntoViewIfNeeded();
  await onlyTheApp(appAnswer(page, app));
});
