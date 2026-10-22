import type { Page } from "@playwright/test";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";
import { expect, test } from "./support/chat.js";

/**
 * KOBE-479: wherever a button is blue, its text and icons are white, in light and dark. Visits the
 * main pages (chat, the Threads panel, the files rail, a console page, My Agents, the Skills
 * Workbench) in both themes and checks every visible button (`button`, `role=button`, links
 * styled as buttons) whose computed background is blue: its text, and every visible descendant's
 * colour, must be white with AA (4.5:1) on the fill. "Blue" comes from the accent token
 * (`--kobe-status-accent`, app/theme.css): a fill within HUE_SPAN of its hue, with real chroma.
 * Colours are read with getComputedStyle through a canvas, so any CSS syntax reads as sRGB; nothing
 * is injected into the page. Spends no model turn and changes nothing on the deployment.
 */
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];
const THEME_COOKIE = "kobe-theme";

const PAGES = [
  { path: "/me/agents", name: "My Agents" },
  { path: "/me/skills?tab=workbench", name: "Skills Workbench" },
  { path: "/admin/team/members", name: "a console page" },
] as const;

interface Offender {
  readonly label: string;
  readonly background: string;
  readonly text: string;
  readonly contrast: number;
}

/** Every visible blue button on the page whose text or icons are not white with AA. */
function blueWithoutWhite(page: Page): Promise<{ checked: number; offenders: Offender[] }> {
  return page.evaluate(() => {
    const HUE_SPAN = 30;
    const MIN_CHROMA = 0.25;
    const MIN_CONTRAST = 4.5;
    const WHITE_AT_LEAST = 245;
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (ctx === null) throw new Error("no 2d canvas");
    const rgba = (css: string): number[] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "rgba(0, 0, 0, 0)";
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data];
    };
    const hue = ([r = 0, g = 0, b = 0]: number[]): number => {
      const max = Math.max(r, g, b);
      const d = max - Math.min(r, g, b);
      if (d === 0) return 0;
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    const chroma = ([r = 0, g = 0, b = 0]: number[]) =>
      (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    const luminance = (c: number[]) => {
      const [r = 0, g = 0, b = 0] = c.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: number[], b: number[]) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };
    const accent = rgba(
      getComputedStyle(document.documentElement).getPropertyValue("--kobe-status-accent").trim(),
    );
    if (chroma(accent) < MIN_CHROMA) throw new Error(`the accent is not blue: ${accent.join()}`);
    const accentHue = hue(accent);
    const isBlue = (c: number[]) => {
      const dh = Math.abs(hue(c) - accentHue);
      return (c[3] ?? 0) > 128 && chroma(c) >= MIN_CHROMA && Math.min(dh, 360 - dh) <= HUE_SPAN;
    };
    const visible = (el: Element) => {
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return box.width > 0 && box.height > 0 && style.visibility !== "hidden";
    };
    const buttons = document.querySelectorAll(
      'button, [role="button"], a[data-slot="button"], a[data-slot="console-button"], summary',
    );
    const offenders: Offender[] = [];
    let checked = 0;
    for (const el of buttons) {
      if (!visible(el) || el.closest("[inert]")) continue;
      const fill = rgba(getComputedStyle(el).backgroundColor);
      if (!isBlue(fill)) continue;
      checked++;
      // The button's own colour and every visible descendant's (labels, lucide icons).
      for (const part of [el, ...el.querySelectorAll("*")]) {
        if (part !== el && !visible(part)) continue;
        const style = getComputedStyle(part);
        // A descendant with its own fill (a badge) is judged on its own fill, not the button's.
        if (part !== el && (rgba(style.backgroundColor)[3] ?? 0) > 128) continue;
        const text = rgba(style.color);
        const ratio = contrast(text, fill);
        const white = text.slice(0, 3).every((v) => v >= WHITE_AT_LEAST);
        if (!white || ratio < MIN_CONTRAST) {
          offenders.push({
            label: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 60),
            background: getComputedStyle(el).backgroundColor,
            text: style.color,
            contrast: Math.round(ratio * 100) / 100,
          });
          break;
        }
      }
    }
    return { checked, offenders };
  });
}

async function check(page: Page, theme: Theme, where: string): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  const { offenders } = await blueWithoutWhite(page);
  expect.soft(offenders, `${theme} ${where}: blue buttons without white text`).toEqual([]);
}

for (const theme of THEMES) {
  test(`blue buttons have white text in ${theme} (KOBE-479)`, async ({
    chat,
    page,
    context,
    baseURL,
  }) => {
    if (!baseURL) throw new Error("KOBE_BASE_URL is required");
    await context.addCookies([{ name: THEME_COOKIE, value: theme, url: baseURL }]);

    await chat.open();
    await check(page, theme, "chat");

    await chat.openThreads();
    await check(page, theme, "Threads panel");
    await chat.closeThreads();

    await chat.showBothPanels("files");
    await check(page, theme, "files rail");

    for (const { path, name } of PAGES) {
      await page.goto(path);
      await expect(page.locator("[data-kobe-panel] main").first()).toBeVisible({
        timeout: SHELL_TIMEOUT_MS,
      });
      await expect(
        page
          .locator("[data-kobe-panel]")
          .getByRole("status")
          .filter({ hasText: /^(Checking your access|Loading)/ }),
      ).toHaveCount(0, { timeout: SHELL_TIMEOUT_MS });
      await check(page, theme, name);
    }
  });
}
