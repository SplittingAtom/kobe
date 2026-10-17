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

/** Pages outside the consoles' navigation. */
const FIXED_PAGES = [
  "/admin",
  "/admin/site",
  "/admin/team",
  "/admin/team/agents/new",
  "/admin/team/skills/new",
  "/me/agents",
  "/me/agents/new",
  "/me/skills",
  "/me/skills/new",
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
  { list: "/me/skills", link: /^\/me\/skills\/(?!new$)[^/]+$/, name: "my-skill" },
  { list: "/me/projects", link: /^\/me\/projects\/[^/]+$/, name: "my-project" },
] as const;

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
    await page.goto(list);
    await settle(page, theme);
    const hrefs = await page
      .locator("main a[href]")
      .evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
    const path = hrefs.map((h) => h.split(/[?#]/)[0] ?? "").find((h) => link.test(h));
    if (path) out.push({ path, name });
  }
  return out;
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

    for (const { path, name } of pages) {
      await test.step(`${theme} ${path}`, async () => {
        await page.goto(path);
        await settle(page, theme);
        // Soft: every page is shot even when an earlier one differs from its baseline.
        await expect.soft(page).toHaveScreenshot([theme, `${name}.png`], {
          fullPage: true,
          animations: "disabled",
          caret: "hide",
          // Times and dates change between runs.
          mask: [page.locator("time")],
        });
      });
    }
  });
}
