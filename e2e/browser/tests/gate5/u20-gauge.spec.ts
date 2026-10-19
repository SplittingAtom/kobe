import type { Page } from "@playwright/test";
import { expect, test } from "../support/chat.js";
import { FAKE_MODEL } from "../support/gate5.js";

/**
 * Gate 5, U20 (KOBE-227): "The gauge equals the latest `run_usage` input tokens over
 * `context_window`; thresholds at 65% and 85%; Compact now with a focus produces a `compaction`
 * entry whose marker shows the summary." The equality is context-gauge.spec.ts (and the API check
 * in e2e/gate5.sh), Compact now is compact-now.spec.ts; the thresholds are here.
 *
 * With the fake model (CI) the team's default model has a 200,000-token window (e2e/gate5.sh) and
 * `kobe-prompt-tokens=<n>` sets the prompt size the call reports: 60%, 70% and 86%. Against a real
 * model the reading is whatever the turn used; the level must then match the rule for it.
 */
const meterOf = (page: Page) => page.getByRole("meter", { name: "Context used" });

function levelFor(percent: number): string {
  if (percent >= 85) return "full";
  return percent >= 65 ? "warn" : "ok";
}

async function reading(page: Page) {
  const meter = meterOf(page);
  await expect(meter).toBeVisible({ timeout: 60_000 });
  const now = Number(await meter.getAttribute("aria-valuenow"));
  const max = Number(await meter.getAttribute("aria-valuemax"));
  return { now, max, percent: (100 * now) / max, level: await meter.getAttribute("data-level") };
}

test("U20: the gauge turns amber at 65% and red at 85% of the model's window", async ({
  chat,
  page,
}) => {
  await chat.open();
  if (!FAKE_MODEL) {
    await chat.ask("No tools. Reply with the single word GAUGE.");
    const r = await reading(page);
    expect(r.level).toBe(levelFor(r.percent));
    return;
  }
  for (const [tokens, level] of [
    [120_000, "ok"],
    [140_000, "warn"],
    [172_000, "full"],
  ] as const) {
    await chat.ask(`kobe-prompt-tokens=${tokens} No tools. Reply with the single word GAUGE.`);
    await expect.poll(async () => (await reading(page)).now, { timeout: 30_000 }).toBe(tokens);
    const r = await reading(page);
    expect(r.max).toBe(200_000);
    expect(r.level, `${tokens} tokens (${r.percent}%)`).toBe(level);
  }
  // Red offers Compact now from the gauge's tooltip.
  await meterOf(page).hover();
  await expect(page.locator('[data-slot="tooltip-content"]').first()).toContainText(
    "Compact this thread",
  );
});
