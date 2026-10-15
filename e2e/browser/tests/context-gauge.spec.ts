import { expect, test } from "./support/chat.js";

/** The usage read's newest call: the prompt the gauge shows is input + cache read + cache write. */
interface LatestCall {
  readonly input_tokens?: number;
  readonly cache_read_tokens?: number;
  readonly cache_write_tokens?: number;
}

const USAGE_PATH = /\/v1\/threads\/[^/]+\/usage$/;

test("the context gauge shows the newest call's prompt against the model's window", async ({
  chat,
  page,
}) => {
  let latest: LatestCall | null = null;
  page.on("response", (res) => {
    if (!res.ok() || !USAGE_PATH.test(new URL(res.url()).pathname)) return;
    res
      .json()
      .then((body: { latest_call?: LatestCall | null }) => {
        latest = body.latest_call ?? null;
      })
      .catch(() => undefined);
  });
  const prompt = () => {
    const call = latest as LatestCall | null;
    return call === null
      ? null
      : (call.input_tokens ?? 0) + (call.cache_read_tokens ?? 0) + (call.cache_write_tokens ?? 0);
  };
  const meter = page.getByRole("meter", { name: "Context used" });

  await chat.open();
  // Unknown before the first model call: no gauge.
  await expect(meter).toHaveCount(0);

  await chat.ask("No tools. Summarise in three sentences what a lighthouse keeper does.");
  await expect(meter).toBeVisible({ timeout: 60_000 });
  await expect(meter).toHaveAttribute("aria-valuetext", /tokens/);
  const max = Number(await meter.getAttribute("aria-valuemax"));
  expect(max).toBeGreaterThan(0);

  // The fill is the usage read's newest call, capped at the window.
  await expect.poll(prompt, { timeout: 30_000 }).toBeGreaterThan(0);
  const offBy = async () =>
    Number(await meter.getAttribute("aria-valuenow")) - Math.min(prompt() ?? -1, max);
  await expect.poll(offBy, { timeout: 30_000 }).toBe(0);

  // Its tooltip repeats the value text ("12k of 128k tokens (9%) · model").
  const text = (await meter.getAttribute("aria-valuetext")) ?? "";
  await meter.hover();
  await expect(page.locator('[data-slot="tooltip-content"]').first()).toContainText(text);
});
