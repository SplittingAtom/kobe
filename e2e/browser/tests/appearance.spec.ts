import { expect, test, type Page } from "@playwright/test";
import { expectAA, expectThemed, paintOf, type Theme } from "./support/colours.js";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";
import { panelOf } from "./support/panel.js";

/**
 * KOBE-501 (theming plan §6, ac-1..ac-3): the site Owner (KOBE_USER) brands the site on Site →
 * Appearance: renames it (the bar's h1 and document.title follow, and the server-rendered HTML of
 * a fresh load already carries the name, so no frame reads "Kobe"), uploads a generated PNG logo
 * (the header's <img>) and favicon (<link rel=icon>), has a `<script>` SVG refused with the reason,
 * picks the Plum preset (AA in both themes on a console page and on the chat, support/colours.ts)
 * and resets to Kobe's defaults. The web caches the branding for 30 s (TH5), so each check polls a
 * fresh server render. It resets the site at the end even when a step fails. No model tokens:
 * `npx playwright test appearance`.
 */
const PAGE = "/admin/site/appearance";
const THEME_COOKIE = "kobe-theme";
/** The web's branding cache (30 s, stale-while-revalidate) plus a request to refresh it. */
const BRANDING_TIMEOUT_MS = 90_000;

/** A 1×1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const SCRIPT_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
);

async function openAppearance(page: Page): Promise<void> {
  await page.goto(PAGE);
  await expect(panelOf(page).getByRole("heading", { level: 1, name: "Appearance" })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await expect(panelOf(page).getByLabel(/^Site name/)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
}

/** The server-rendered HTML of a fresh load of `path`, once it satisfies `check`. */
async function rendered(
  page: Page,
  path: string,
  check: (html: string) => boolean,
): Promise<string> {
  let html = "";
  await expect
    .poll(
      async () => {
        html = await (await page.request.get(path)).text();
        return check(html);
      },
      { timeout: BRANDING_TIMEOUT_MS, intervals: [2_000, 5_000] },
    )
    .toBe(true);
  return html;
}

/** Saves the form; the page reloads itself afterwards. */
async function save(page: Page): Promise<void> {
  const reloaded = page.waitForEvent("load");
  await panelOf(page).getByRole("button", { name: "Save", exact: true }).click();
  await reloaded;
}

async function resetByApi(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await fetch("/v1/site/branding/reset", { method: "POST" });
  });
}

/** AA text on a console page and on the chat, in `theme`. */
async function checkContrast(page: Page, theme: Theme): Promise<void> {
  await openAppearance(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  const panel = panelOf(page);
  const heading = panel.getByRole("heading", { level: 1, name: "Appearance" });
  expectThemed("console heading", await paintOf(heading), theme);
  expectAA(`${theme} console heading`, await paintOf(heading));
  const save = panel.getByRole("button", { name: "Save", exact: true });
  expectAA(`${theme} primary button`, await paintOf(save));
  expectAA(
    `${theme} secondary button`,
    await paintOf(panel.getByRole("button", { name: "Choose a logo…" })),
  );

  await page.goto("/");
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(message).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  expectThemed("chat composer", await paintOf(message), theme);
  const brand = page.locator("header h1").first();
  expectAA(`${theme} chat bar`, await paintOf(brand));
}

test("an admin brands the site: name, logo, favicon, preset, refusals and reset (KOBE-501)", async ({
  page,
  context,
  baseURL,
}) => {
  if (!baseURL) throw new Error("KOBE_BASE_URL is required");
  const name = `Acme ${Date.now() % 100_000}`;
  const panel = panelOf(page);
  await openAppearance(page);

  try {
    // Rename: the title and the bar, already in the server's HTML.
    const field = panel.getByLabel(/^Site name/);
    await field.fill(name);
    await expect(panel.getByText(`Site console · ${name}`)).toBeVisible();
    await save(page);
    const html = await rendered(page, "/", (h) => h.includes(`<title>${name}</title>`));
    expect(html).not.toMatch(/<h1[^>]*>Kobe<\/h1>/);
    await page.goto("/");
    await expect(page.locator("header h1").first()).toHaveText(name, { timeout: SHELL_TIMEOUT_MS });
    expect(await page.title()).toBe(name);

    // Logo and favicon: applied on upload.
    await openAppearance(page);
    await panel
      .getByLabel("Logo file")
      .setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
    await expect(panel.getByText(/Logo saved/)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await panel
      .getByLabel("Favicon file")
      .setInputFiles({ name: "favicon.png", mimeType: "image/png", buffer: PNG });
    await expect(panel.getByText(/Favicon saved/)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });

    // A `<script>` SVG is refused with the reason.
    await panel
      .getByLabel("Dark logo file")
      .setInputFiles({ name: "bad.svg", mimeType: "image/svg+xml", buffer: SCRIPT_SVG });
    await expect(panel.getByText(/This SVG is refused/)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(panel.getByText(/Export the file as Plain SVG/)).toBeVisible();

    await rendered(
      page,
      "/",
      (h) =>
        h.includes("/v1/site/branding/assets/logo?v=") &&
        h.includes("/v1/site/branding/assets/favicon?v="),
    );
    await page.goto("/");
    await expect(page.locator('header h1 img[data-logo="light"]')).toHaveAttribute(
      "src",
      /^\/v1\/site\/branding\/assets\/logo\?v=[0-9a-f]{64}$/,
      { timeout: SHELL_TIMEOUT_MS },
    );
    await expect(page.locator('head link[rel="icon"]').first()).toHaveAttribute(
      "href",
      /\/v1\/site\/branding\/assets\/favicon\?v=[0-9a-f]{64}/,
    );

    // The Plum preset: AA in both themes on a console page and on the chat.
    await openAppearance(page);
    await panel.getByRole("radio", { name: "Plum" }).check();
    await save(page);
    await rendered(page, "/", (h) => h.includes("data-kobe-branding"));
    for (const theme of ["light", "dark"] as const) {
      await context.addCookies([{ name: THEME_COOKIE, value: theme, url: baseURL }]);
      await checkContrast(page, theme);
    }
    await context.clearCookies({ name: THEME_COOKIE });

    // Reset: "Kobe" again.
    await openAppearance(page);
    await panel.getByRole("button", { name: "Reset to Kobe defaults" }).click();
    const dialog = page.getByRole("alertdialog", { name: /Reset the appearance/ });
    const reloaded = page.waitForEvent("load");
    await dialog.getByRole("button", { name: "Reset", exact: true }).click();
    await reloaded;
    await rendered(page, "/", (h) => h.includes("<title>Kobe</title>") && !h.includes(name));
  } finally {
    await resetByApi(page);
  }
});
