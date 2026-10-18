import type { Locator } from "@playwright/test";
import { RUN_START_TIMEOUT_MS, RUN_TIMEOUT_MS, SHELL_TIMEOUT_MS } from "../support/constants.js";
import { expect, test } from "../support/chat.js";
import {
  allowApproval,
  bashTurn,
  FAKE_MODEL,
  longAnswer,
  pageApi,
  preferences,
  putPreferences,
  secondBrowser,
  shareTurn,
} from "../support/gate5.js";

/**
 * Gate 5, U21 (KOBE-227): "Reasoning, tool cards (with >64 KB output on expand), hover footers
 * and every system marker render for a recorded thread; the Detail toggle expands all and
 * persists per user." The real-model run needs a team default model that reasons
 * (KOBE_GATE5_REASONING=1); the fake model reasons on `think?`.
 */
const REASONS = FAKE_MODEL || process.env["KOBE_GATE5_REASONING"] === "1";
const toggleOf = (l: Locator) => l.locator("button[aria-expanded]").first();

test("U21: reasoning, a tool card, the hover footer and the run's markers render after a reload", async ({
  chat,
  page,
}) => {
  test.setTimeout(4 * RUN_TIMEOUT_MS);
  await chat.open();
  if (REASONS) {
    await chat.ask(FAKE_MODEL ? "think?" : "Think it through first, then reply: what is 17 × 23?");
  }
  await chat.ask(bashTurn("echo g5-tool-card | tee /workspace/g5-markers.txt"));
  // An approval and a stopped run leave their markers in the thread's record.
  await chat.send(shareTurn("g5-markers.txt", "G5 markers"));
  await allowApproval(page);
  await chat.waitForIdle();
  await chat.send(longAnswer("No tools. Write a 2000-word story about the sea."));
  await expect(chat.steering).toHaveAttribute("data-state", "active", {
    timeout: RUN_START_TIMEOUT_MS,
  });
  await chat.steering.getByRole("button", { name: "Stop", exact: true }).click();
  await chat.waitForIdle();

  await page.reload();
  await expect(chat.composer).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  if (REASONS) {
    const reasoning = page.getByRole("button", { name: /^Reasoning/ }).first();
    await expect(reasoning).toBeVisible();
    if ((await reasoning.getAttribute("aria-expanded")) !== "true") await reasoning.click();
    await expect(chat.answers.first()).toContainText(FAKE_MODEL ? "fake reasoning" : /\S/);
  }
  const card = page.getByRole("region", { name: "Tool call bash" }).first();
  await expect(card).toBeVisible();
  if ((await toggleOf(card).getAttribute("aria-expanded")) !== "true") await toggleOf(card).click();
  await expect(card).toContainText("g5-tool-card");

  // Hovering an answer shows its footer (model, usage, time).
  await chat.answers.last().hover();
  await expect(chat.answers.last().getByRole("group", { name: "Answer details" })).toBeVisible();

  for (const kind of ["model", "approval", "stopped"]) {
    await expect(
      page.locator(`[data-kobe-marker="${kind}"]`).first(),
      `marker ${kind}`,
    ).toBeVisible();
  }
});

test("U21: a tool output over 64 KB is read in full when its card opens", async ({
  chat,
  page,
}) => {
  await chat.open();
  // Pi trims what a tool returns before Kobe sees it (bash and read at 50 KB, MCP at 20 KB of
  // text), but the chat's 64 KB limit is on the stored JSON of the output: 40,000 double quotes
  // are 40 KB of text (under Pi's limit) and 80 KB escaped, so a real bash output crosses it.
  // The card also shows the command, so the output's last line is computed by the shell: the
  // marker appears only in the output (after the 2,000-character preview), never in the input.
  const END = "G5-OUTPUT-END-40002";
  const threadId = await chat.ask(
    bashTurn(`head -c 40000 /dev/zero | tr '\\0' '"'; echo; echo G5-OUTPUT-END-$((40000 + 2))`),
  );
  const thread = await pageApi<{ entries?: { payload_truncated?: boolean }[] }>(
    page,
    "GET",
    `/v1/threads/${threadId}`,
  );
  const trimmed = (thread.json.entries ?? []).some((e) => e.payload_truncated === true);
  expect(trimmed, "the stored output is over 64 KB, so the chat lists only its preview").toBe(true);
  // The recorded thread (U21), not this tab's live stream (whose tool.result carries its own
  // preview): reload, so the card is built from the listed, trimmed entry.
  await page.reload();
  await expect(chat.composer).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  const card = page.getByRole("region", { name: "Tool call bash" }).last();
  await expect(card).not.toContainText(END);
  await toggleOf(card).click();
  await expect(card).toContainText(END, { timeout: 30_000 });
});

test("U21: the Detail toggle opens every block and is stored for the member", async ({
  chat,
  page,
  browser,
}) => {
  await chat.open();
  const before = (await preferences(page))["detail_expanded"] ?? false;
  await chat.ask(bashTurn("echo g5-detail"));
  const card = page.getByRole("region", { name: "Tool call bash" }).first();
  try {
    await putPreferences(page, { detail_expanded: false });
    await page.reload();
    await expect(toggleOf(card)).toHaveAttribute("aria-expanded", "false", {
      timeout: SHELL_TIMEOUT_MS,
    });
    await page.locator("body").press("ControlOrMeta+Shift+d");
    await expect(toggleOf(card)).toHaveAttribute("aria-expanded", "true");
    await expect.poll(async () => (await preferences(page))["detail_expanded"]).toBe(true);
    const second = await secondBrowser(browser);
    try {
      await second.goto(page.url());
      const card2 = second.getByRole("region", { name: "Tool call bash" }).first();
      await expect(toggleOf(card2)).toHaveAttribute("aria-expanded", "true", {
        timeout: SHELL_TIMEOUT_MS,
      });
    } finally {
      await second.context().close();
    }
  } finally {
    await putPreferences(page, { detail_expanded: before });
  }
});
