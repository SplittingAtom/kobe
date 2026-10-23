import { expect, test } from "./support/chat.js";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";
import { styleViolations, watchStyleViolations } from "./support/csp.js";

/**
 * KOBE-487: after a deploy, an open tab offers a reload instead of running stale code. The spec
 * fakes a newer build by answering `/api/build` itself: a check while the build is unchanged shows
 * nothing; the periodic check (the page clock jumps ten minutes) finds the "newer" build and shows
 * the banner; the page never reloads by itself; Reload reloads and keeps the composer's draft.
 * No model turn, nothing created on the server.
 */
const NOTICE = "Kobe was updated. Reload to get the latest version.";
const BUILD = "**/api/build";

test("a newer build shows the reload banner, and Reload keeps the draft", async ({
  chat,
  page,
}) => {
  await page.clock.install();
  await chat.open();
  await watchStyleViolations(page);
  const banner = page.getByRole("status").filter({ hasText: NOTICE });

  // The endpoint answers this page's own build (the meta tag): a focus check shows nothing.
  const served = await page.evaluate(async () => {
    const res = await fetch("/api/build", { cache: "no-store" });
    return { status: res.status, body: (await res.json()) as { buildId?: unknown } };
  });
  expect(served.status).toBe(200);
  expect(typeof served.body.buildId).toBe("string");
  const own = String(served.body.buildId);
  await expect(page.locator('meta[name="kobe-build"]')).toHaveAttribute("content", own);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.clock.fastForward("00:05");
  await expect(banner).toHaveCount(0);

  // A deploy happened: the endpoint now names another build.
  await page.route(BUILD, (route) =>
    route.fulfill({
      json: { buildId: `${own}-newer` },
      headers: { "cache-control": "no-store" },
    }),
  );
  await chat.composer.fill("unsent draft for KOBE-487");
  await page.clock.fastForward("10:01");
  await expect(banner).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  // Non-blocking: the composer still takes input, and nothing reloaded.
  await chat.composer.press("End");
  await expect(chat.composer).toHaveValue("unsent draft for KOBE-487");
  expect(await styleViolations(page)).toEqual([]);

  // Reload (from the keyboard) brings the real build back, with the draft.
  await page.unroute(BUILD);
  const reload = banner.getByRole("button", { name: "Reload", exact: true });
  await reload.focus();
  await Promise.all([page.waitForEvent("load"), page.keyboard.press("Enter")]);
  await expect(chat.composer).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await expect(chat.composer).toHaveValue("unsent draft for KOBE-487");
  await expect(banner).toHaveCount(0);
  await chat.composer.fill("");
});
