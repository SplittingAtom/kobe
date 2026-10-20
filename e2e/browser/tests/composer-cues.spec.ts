import type { Locator, Page } from "@playwright/test";
import { RUN_START_TIMEOUT_MS, RUN_TIMEOUT_MS } from "./support/constants.js";
import { expect, test, filesSection } from "./support/chat.js";

/**
 * KOBE-374: gold tool badges, the whole-composer focus outline, its pulse while a run goes (none
 * under reduced motion), and a workspace file dragged from the Files tree into the composer as an
 * @file mention. Light and dark screenshots of the badge, the focused and the pulsing composer are
 * attached to the report (the ledger's evidence). The dragged file is deleted at the end.
 */
const TEAM_KEY = "kobe.lastTeamId";
/** Streams long enough for the pulse checks to happen while the run goes. */
const STORY =
  "No tools. Write a detailed 1500-word short story about a lighthouse keeper and a storm.";

/** The element's `prop` colour as [r, g, b] (any CSS colour syntax, through a canvas). */
function rgbOf(el: Locator, prop: "color" | "outlineColor" | "backgroundColor"): Promise<number[]> {
  return el.evaluate((node, p) => {
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (ctx === null) throw new Error("no 2d canvas");
    ctx.fillStyle = getComputedStyle(node)[p];
    ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
  }, prop);
}

/** Gold reads as red and green well above blue. */
const goldish = ([r = 0, g = 0, b = 0]: number[]) => r > b + 40 && g > b + 20;
const greenish = ([r = 0, g = 0, b = 0]: number[]) => g > r && g > b;

/** Screenshots of `cue` in both themes, attached to the report. */
async function shoot(
  page: Page,
  name: string,
  cue: Locator,
  animations: "allow" | "disabled" = "disabled",
): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await test.info().attach(`${name}-${theme}.png`, {
      body: await cue.screenshot({ animations }),
      contentType: "image/png",
    });
  }
  await page.evaluate(() => delete document.documentElement.dataset.theme);
}

/** The member's own workspace API, called from the page (session cookie, CSRF Origin). */
async function workspace(page: Page, method: "POST" | "DELETE", path: string): Promise<number> {
  return page.evaluate(
    async ({ method, path, teamKey }) => {
      const team = window.localStorage.getItem(teamKey);
      const headers: Record<string, string> = team ? { "x-kobe-team": team } : {};
      if (method === "DELETE") {
        const q = encodeURIComponent(path);
        return (await fetch(`/v1/workspace/files?path=${q}`, { method, headers })).status;
      }
      const slash = path.lastIndexOf("/");
      const form = new FormData();
      form.set("path", path.slice(0, slash));
      form.set("file", new File(["kobe-374\n"], path.slice(slash + 1), { type: "text/plain" }));
      return (await fetch("/v1/workspace/files", { method, headers, body: form })).status;
    },
    { method, path, teamKey: TEAM_KEY },
  );
}

const panelOf = (page: Page) => page.locator("[data-kobe-composer-panel]");

test("gold tool badge on a tool step, outcome colour unchanged (KOBE-374 ac-1)", async ({
  chat,
  page,
}) => {
  await chat.open();
  await chat.ask("Use the bash tool to run `echo kobe-374`, then reply with the single word OK.");
  const badge = page.locator("[data-kobe-tool-badge]").first();
  await expect(badge).toBeVisible({ timeout: RUN_TIMEOUT_MS });
  expect(goldish(await rgbOf(badge, "backgroundColor"))).toBe(true);
  const done = page.locator('[data-kobe-outcome-label="done"]').first();
  expect(greenish(await rgbOf(done, "color"))).toBe(true);
  await shoot(page, "tool-badge", page.getByRole("region", { name: /^Tool call / }).first());
});

test("the whole composer takes the focus outline; the field has no ring (ac-2)", async ({
  chat,
  page,
}) => {
  await chat.open();
  const panel = panelOf(page);
  await chat.composer.click();
  const outline = await panel.evaluate((el) => {
    const s = getComputedStyle(el);
    return { width: s.outlineWidth, style: s.outlineStyle };
  });
  expect(outline).toEqual({ width: "2px", style: "solid" });
  expect(await chat.composer.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("none");
  const box = await panel.boundingBox();
  // Keyboard: Tab from the field lands on a control inside the panel, which keeps its own ring.
  await chat.composer.press("Tab");
  expect(await panel.evaluate((el) => el.matches(":focus-within"))).toBe(true);
  expect(await panel.boundingBox()).toEqual(box);
  await chat.composer.click();
  await shoot(page, "composer-focused", panel);
});

test("the composer pulses while a run goes and stops after Stop (ac-3)", async ({ chat, page }) => {
  await chat.open();
  await chat.send(STORY);
  const panel = panelOf(page);
  await expect(panel).toHaveAttribute("data-running", "true", { timeout: RUN_START_TIMEOUT_MS });
  expect(await panel.evaluate((el) => getComputedStyle(el).animationName)).toContain(
    "kobe-composer-pulse",
  );
  expect(greenish(await rgbOf(panel, "outlineColor"))).toBe(true);
  await shoot(page, "composer-pulsing", panel, "allow");
  await chat.steering.locator("[data-kobe-stop]").click();
  await chat.waitForIdle();
  await expect(panel).not.toHaveAttribute("data-running");
});

test("reduced motion: the running composer does not move (ac-3)", async ({ chat, page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await chat.open();
  await chat.send(STORY);
  const panel = panelOf(page);
  await expect(panel).toHaveAttribute("data-running", "true", { timeout: RUN_START_TIMEOUT_MS });
  expect(await panel.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  await chat.steering.locator("[data-kobe-stop]").click();
  await chat.waitForIdle();
});

test("drag a workspace file onto the composer: an @file chip (ac-4)", async ({ chat, page }) => {
  const dir = `kobe-374-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await chat.open();
  expect(await workspace(page, "POST", `${dir}/notes.txt`)).toBe(201);
  try {
    const files = filesSection(page);
    // Listed when Files came on screen (KOBE-461); list again for the files just written.
    await files.getByRole("button", { name: "Refresh files" }).click();
    const tree = files.getByRole("tree", { name: "Files in your workspace" });
    const row = (name: string) => tree.getByRole("treeitem", { name, exact: true });
    await row(dir).click();
    await row("notes.txt").dragTo(panelOf(page));
    await expect(
      page.getByRole("list", { name: "Mentioned files" }).getByText(`@${dir}/notes.txt`),
    ).toBeVisible();
    await expect(chat.composer).toHaveValue(`@file(${dir}/notes.txt) `);
    // A folder is refused; the file stays where it was (a drop on the composer never moves).
    await row(dir).dragTo(panelOf(page));
    await expect(
      page.getByRole("list", { name: "Mentioned files" }).getByRole("listitem"),
    ).toHaveCount(1);
    await expect(row("notes.txt")).toHaveAttribute("aria-level", "2");
  } finally {
    await chat.composer.fill("");
    expect(await workspace(page, "DELETE", dir)).toBe(204);
  }
});
