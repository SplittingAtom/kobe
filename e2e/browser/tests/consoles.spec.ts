import { expect, test, type Page } from "@playwright/test";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";

/**
 * Screenshots of every console and My-area page in light and dark (KOBE-294 ac-3), for the move
 * of the consoles from CSS modules to Tailwind (KOBE-294..296). Take the baseline before a page's
 * styling changes, then compare after:
 *
 *   npx playwright test consoles --update-snapshots=all   # baseline (writes console-shots/)
 *   npx playwright test consoles                          # compare; diffs in test-results/
 *
 * `KOBE_USER` must be the site Owner (every Site console section) and a team admin of the active
 * team (every Team console section, plus the My area). The pages come from the consoles' own
 * navigation, so sections added later are covered without editing this file; detail pages use the
 * first item of their list when there is one. Nothing is changed on the deployment.
 * Screenshots show deployment data: they stay out of git (`console-shots/` is ignored).
 */

const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];
const THEME_COOKIE = "kobe-theme";

/**
 * Pages outside the consoles' navigation, and sections shot by name so a change to the nav can't
 * drop them: the three KOBE-291 built (no baseline yet: take one with --update-snapshots).
 */
const FIXED_PAGES = [
  "/admin/site/audit",
  "/admin/site/backup",
  "/admin/team/inventory",
  "/admin",
  "/admin/site",
  "/admin/team",
  "/admin/team/agents/new",
  "/me/agents",
  "/me/agents/new",
  "/me/skills",
  "/me/skills?tab=workbench",
  "/me/projects",
  "/me/memory",
  "/me/schedules",
  "/me/connectors",
] as const;

/** Each console's navigation landmark (components/admin/console-nav.tsx). */
const CONSOLE_NAVS = [
  { home: "/admin/site", nav: "Site console sections" },
  { home: "/admin/team", nav: "Team console sections" },
] as const;

/** Detail pages: the first link on `list` whose path matches `link`, shot as `name`. */
const DETAILS = [
  {
    list: "/admin/team/agents",
    link: /^\/admin\/team\/agents\/(?!new$)[^/]+$/,
    name: "team-agent",
  },
  {
    list: "/admin/team/skills",
    link: /^\/admin\/team\/skills\/(?!new$)[^/]+$/,
    name: "team-skill",
  },
  { list: "/me/agents", link: /^\/me\/agents\/(?!new$)[^/]+$/, name: "my-agent" },
  // The Workbench editor (KOBE-321) of the first draft listed.
  { list: "/me/skills?tab=workbench", link: /^\/me\/skills\/drafts\/[^/]+$/, name: "skill-draft" },
  { list: "/me/projects", link: /^\/me\/projects\/[^/]+$/, name: "my-project" },
  // An eval report, linked from the team agent found above (when it has one).
  {
    list: "team-agent",
    link: /^\/admin\/team\/agents\/[^/]+\/evals\/[^/]+$/,
    name: "team-agent-eval",
  },
] as const;

/** Phone width: the nav folds behind its toggle, tables scroll, forms wrap. */
const MOBILE = { width: 390, height: 844 } as const;
const MOBILE_PAGES = [
  "/admin",
  "/admin/site",
  "/admin/team",
  "/admin/team/invites",
  "/admin/team/members",
  // Wide tables and the audit filters (KOBE-291).
  "/admin/site/audit",
  "/admin/team/inventory",
  "/me/agents",
] as const;

/** Side-by-side choices in a ChoiceGroup sit at most this far apart (review S2: 16 px gap). */
const MAX_CHOICE_GAP_PX = 20;

/** Waits until the shell has checked access and the page has loaded its data. */
async function settle(page: Page, theme: Theme): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(page.locator("main").first()).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await expect(
    page.getByRole("status").filter({ hasText: /^(Checking your access|Loading)/ }),
  ).toHaveCount(0, { timeout: SHELL_TIMEOUT_MS });
  // Late requests (counts, previews) settle; a page that keeps polling is shot as it stands.
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
}

/** `/admin/team/members` → `admin-team-members`. */
const slug = (path: string) => path.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-") || "root";

/** The section links of each console's navigation, in nav order. */
async function navPages(page: Page, theme: Theme): Promise<string[]> {
  const out: string[] = [];
  for (const { home, nav } of CONSOLE_NAVS) {
    await page.goto(home);
    await settle(page, theme);
    const links = page.getByRole("navigation", { name: nav }).getByRole("link");
    for (const href of await links.evaluateAll((as) => as.map((a) => a.getAttribute("href")))) {
      if (href) out.push(href);
    }
  }
  return out;
}

/** The first detail link on each list page, where the list has one. */
async function detailPages(page: Page, theme: Theme): Promise<{ path: string; name: string }[]> {
  const out: { path: string; name: string }[] = [];
  for (const { list, link, name } of DETAILS) {
    // A list is a path, or the name of a detail page found earlier.
    const from = list.startsWith("/") ? list : out.find((d) => d.name === list)?.path;
    if (!from) continue;
    await page.goto(from);
    await settle(page, theme);
    const hrefs = await page
      .locator("main a[href]")
      .evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
    const path = hrefs.map((h) => h.split(/[?#]/)[0] ?? "").find((h) => link.test(h));
    if (path) out.push({ path, name });
  }
  return out;
}

/** Horizontal gaps between neighbouring choices of each ChoiceGroup on the page, in px. */
function choiceGaps(page: Page): Promise<number[]> {
  return page.locator('[data-slot="console-choice-group"]').evaluateAll((groups) =>
    groups.flatMap((g) => {
      const boxes = [...g.querySelectorAll('[data-slot="console-choice"]')].map((c) =>
        c.getBoundingClientRect(),
      );
      return boxes.slice(1).flatMap((b, i) => {
        const prev = boxes[i];
        // Only neighbours on the same line.
        return prev && Math.abs(prev.top - b.top) < 2 ? [b.left - prev.right] : [];
      });
    }),
  );
}

/**
 * Shoots one page. A page that fails (navigation, a load that never settles) is recorded and the
 * run goes on to the next, so one broken page never hides the rest.
 */
async function shoot(
  page: Page,
  theme: Theme,
  path: string,
  name: string[],
  failures: string[],
  before?: () => Promise<void>,
): Promise<void> {
  await test.step(`${theme} ${path}`, async () => {
    try {
      await page.goto(path);
      await settle(page, theme);
      await before?.();
      for (const gap of await choiceGaps(page)) {
        expect.soft(gap, `${path}: space between choices`).toBeLessThanOrEqual(MAX_CHOICE_GAP_PX);
      }
      // Soft: every page is shot even when an earlier one differs from its baseline.
      await expect.soft(page).toHaveScreenshot(name, {
        fullPage: true,
        animations: "disabled",
        caret: "hide",
        // Times and dates change between runs.
        mask: [page.locator("time")],
      });
    } catch (error) {
      failures.push(`${path}: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
    }
  });
}

for (const theme of THEMES) {
  test(`console and My-area pages in ${theme}`, async ({ page, context, baseURL }) => {
    test.setTimeout(20 * 60_000);
    if (!baseURL) throw new Error("KOBE_BASE_URL is required");
    await context.addCookies([{ name: THEME_COOKIE, value: theme, url: baseURL }]);

    const sections = await navPages(page, theme);
    expect(
      sections.length,
      "the Owner and team admin sees both consoles' sections",
    ).toBeGreaterThan(10);
    const pages = [
      ...[...new Set([...FIXED_PAGES, ...sections])].map((path) => ({ path, name: slug(path) })),
      ...(await detailPages(page, theme)),
    ];

    const failures: string[] = [];
    for (const { path, name } of pages) {
      await shoot(page, theme, path, [theme, `${name}.png`], failures);
    }
    expect(failures, "pages that could not be shot").toEqual([]);
  });
}

test("console and My-area pages at phone width", async ({ page, context, baseURL }) => {
  test.setTimeout(10 * 60_000);
  if (!baseURL) throw new Error("KOBE_BASE_URL is required");
  const theme: Theme = "light";
  await context.addCookies([{ name: THEME_COOKIE, value: theme, url: baseURL }]);
  await page.setViewportSize(MOBILE);

  const failures: string[] = [];
  for (const path of MOBILE_PAGES) {
    await shoot(page, theme, path, ["mobile", `${slug(path)}.png`], failures);
  }
  // The folded section list, opened from its toggle.
  await shoot(page, theme, "/admin/team/invites", ["mobile", "team-nav-open.png"], failures, () =>
    page
      .getByRole("navigation", { name: "Team console sections" })
      .getByRole("button", { expanded: false })
      .click(),
  );
  expect(failures, "pages that could not be shot").toEqual([]);
});
