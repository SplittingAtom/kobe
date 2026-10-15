// @vitest-environment happy-dom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { openApp } from "../chat/testing";
import { IconActionProvider } from "./icon-action";
import { ThemeToggle } from "./theme-toggle";
import { resetThemeQueryForTests } from "./use-theme";

/**
 * KOBE-282 (ac-2): a bar button flips light/dark. The choice lands on `<html data-theme>` (which
 * every themed surface keys on, app/theme.css) and in a cookie the root layout reads; with no
 * choice the theme follows the OS, live.
 */
let osDark = false;
const listeners = new Set<() => void>();
let cookies: string[] = [];

function setOs(dark: boolean) {
  osDark = dark;
  for (const l of listeners) l();
}

beforeEach(() => {
  osDark = false;
  listeners.clear();
  cookies = [];
  delete document.documentElement.dataset.theme;
  resetThemeQueryForTests();
  const real = window.matchMedia.bind(window);
  vi.stubGlobal("matchMedia", (query: string) =>
    query !== "(prefers-color-scheme: dark)"
      ? real(query)
      : {
          get matches() {
            return query === "(prefers-color-scheme: dark)" && osDark;
          },
          media: query,
          addEventListener: (_: string, l: () => void) => listeners.add(l),
          removeEventListener: (_: string, l: () => void) => listeners.delete(l),
        },
  );
  vi.spyOn(document, "cookie", "set").mockImplementation((v: string) => {
    cookies.push(v);
  });
});

afterEach(() => {
  cleanup();
  resetThemeQueryForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.theme;
});

const toggle = (pressed: boolean) => screen.getByRole("button", { name: "Dark theme", pressed });

const renderToggle = () =>
  render(
    <IconActionProvider>
      <ThemeToggle />
    </IconActionProvider>,
  );

describe("theme toggle (KOBE-282)", () => {
  it("is a toggle button named Dark theme; its icon shows the current theme", () => {
    renderToggle();
    const button = toggle(false);
    // Both icons are in the DOM; app/theme.css shows the one matching the theme, so the server's
    // first paint is already right (it cannot know the OS setting).
    expect(button.querySelector("[data-theme-icon='light']")).not.toBeNull();
    expect(button.querySelector("[data-theme-icon='dark']")).not.toBeNull();
  });

  it("follows the OS while nothing is chosen", () => {
    osDark = true;
    renderToggle();
    expect(toggle(true)).toBeTruthy();
    act(() => setOs(false));
    expect(toggle(false)).toBeTruthy();
  });

  it("a press sets <html data-theme> and saves the choice in a cookie", async () => {
    const user = userEvent.setup();
    renderToggle();
    await user.click(toggle(false));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(cookies).toEqual(["kobe-theme=dark; Path=/; Max-Age=31536000; SameSite=Lax"]);

    await user.click(toggle(true));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(cookies.at(-1)).toBe("kobe-theme=light; Path=/; Max-Age=31536000; SameSite=Lax");
  });

  it("a saved choice wins over the OS", () => {
    document.documentElement.dataset.theme = "light";
    osDark = true;
    renderToggle();
    expect(toggle(false)).toBeTruthy();
  });

  it("sits in the utility bar's first row", async () => {
    const fake = new FakeKobe();
    vi.stubGlobal("fetch", fake.fetch);
    openApp(fake);
    const row = await screen.findByRole("banner");
    const first = row.querySelector<HTMLElement>('[data-bar-row="1"]');
    expect(first).not.toBeNull();
    expect(
      await within(first as HTMLElement).findByRole("button", {
        name: "Dark theme",
        pressed: false,
      }),
    ).toBeTruthy();
  });
});
