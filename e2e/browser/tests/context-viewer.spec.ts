import { expect, test } from "./support/chat.js";
import { RUN_TIMEOUT_MS } from "./support/constants.js";
import { styleViolations, watchStyleViolations } from "./support/csp.js";

/**
 * KOBE-471 (spec docs/specs/context-viewer.md, route KOBE-470): after one model turn the context
 * gauge under the composer opens the context viewer over the workspace: labelled sections of raw
 * text, a stacked gauge with segments and a legend; a legend row scrolls the text to its first
 * section; Escape closes it and focus returns to the gauge. No style-src CSP violation. Run with
 * KOBE_TEAM=team1.
 */
test("context viewer: open from the gauge, sections and gauge, legend scrolls, Escape closes", async ({
  chat,
  page,
}) => {
  await chat.open();
  await watchStyleViolations(page);
  await chat.ask("No tools. Name three colours of the rainbow, one word each.");
  const meter = page.getByRole("meter", { name: "Context used" });
  await expect(meter).toBeVisible({ timeout: 60_000 });
  await expect(meter).toHaveAttribute("aria-haspopup", "dialog");

  await meter.click();
  const dialog = page.getByRole("dialog", { name: "Context" });
  await expect(dialog).toBeVisible();
  // The rest of the workspace is inert behind it.
  const chatInert = () =>
    page.evaluate(() => document.getElementById("kobe-chat-main")?.closest("[inert]") != null);
  expect(await chatInert()).toBe(true);
  await expect(page.locator("[data-kobe-panel='context-viewer']")).toBeVisible();

  // Read live from the sandbox (it may wake first): labelled sections render as text.
  const text = dialog.getByRole("region", { name: "Context text" });
  await expect(text.getByText(/^System prompt · /).first()).toBeVisible({
    timeout: RUN_TIMEOUT_MS,
  });

  // The gauge: one segment per kind present, the legend with tokens and shares.
  expect(await dialog.locator("[data-context-segment]").count()).toBeGreaterThan(1);
  const legend = dialog.getByRole("list", { name: "Context by kind" });
  await expect(legend.getByRole("listitem").first()).toContainText(/tokens.*%/);

  // The prompt comes after the system prompt and the tool definitions, out of view: its legend
  // row scrolls the text to it.
  await legend.locator("[data-context-legend='user_message']").click();
  await expect(text.locator("[data-active]")).toBeVisible();
  await expect(text.locator("[data-active]")).toHaveText(/^User prompt · /);

  // Search marks a match.
  await dialog.getByRole("searchbox", { name: "Search the context" }).fill("rainbow");
  await expect(dialog.getByRole("status").filter({ hasText: /of \d+/ })).toBeVisible();
  await expect(text.locator("mark").first()).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(meter).toBeFocused();
  expect(await styleViolations(page)).toEqual([]);
});
