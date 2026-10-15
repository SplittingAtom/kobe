import { describe, expect, it } from "vitest";
import {
  effectiveTheme,
  otherTheme,
  parseTheme,
  THEME_COOKIE,
  themeCookie,
  themeFromCookies,
} from "./theme";

/** KOBE-282 (ac-2): the saved choice is a cookie the root layout reads on the server. */
describe("theme choice", () => {
  it("accepts only light and dark; anything else means follow the OS", () => {
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("dark")).toBe("dark");
    for (const v of [undefined, null, "", "Dark", "auto", "dark;"])
      expect(parseTheme(v)).toBeNull();
  });

  it("reads the choice from the request's cookies", () => {
    const store = (value?: string) => ({
      get: (name: string) => (name === THEME_COOKIE && value !== undefined ? { value } : undefined),
    });
    expect(themeFromCookies(store("dark"))).toBe("dark");
    expect(themeFromCookies(store("purple"))).toBeNull();
    expect(themeFromCookies(store())).toBeNull();
  });

  it("writes a year-long, site-wide, SameSite=Lax cookie, Secure over https", () => {
    expect(themeCookie("dark", false)).toBe(
      "kobe-theme=dark; Path=/; Max-Age=31536000; SameSite=Lax",
    );
    expect(themeCookie("light", true)).toBe(
      "kobe-theme=light; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
    );
  });

  it("an explicit choice wins over the OS; without one the OS decides", () => {
    expect(effectiveTheme("light", true)).toBe("light");
    expect(effectiveTheme("dark", false)).toBe("dark");
    expect(effectiveTheme(null, true)).toBe("dark");
    expect(effectiveTheme(null, false)).toBe("light");
    expect(otherTheme("light")).toBe("dark");
    expect(otherTheme("dark")).toBe("light");
  });
});
