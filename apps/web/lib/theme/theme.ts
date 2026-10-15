/**
 * Light/dark theme choice (KOBE-282). The choice is per browser: a cookie the root layout reads on
 * the server to set `<html data-theme>`, so the first paint is already in that theme without an
 * inline script (the nonce CSP, proxy.ts). No cookie means "follow the OS" (prefers-color-scheme);
 * app/theme.css implements both cases.
 */
export type Theme = "light" | "dark";

export const THEME_COOKIE = "kobe-theme";
/** One year, in seconds. */
export const THEME_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;
/** The media query behind "follow the OS". */
export const OS_DARK_QUERY = "(prefers-color-scheme: dark)";

/** A saved choice, or null (follow the OS) for anything that is not exactly light or dark. */
export function parseTheme(value: string | null | undefined): Theme | null {
  return value === "light" || value === "dark" ? value : null;
}

/** The choice in a request's cookies (Next's `cookies()` store has this shape). */
export function themeFromCookies(store: {
  get(name: string): { value: string } | undefined;
}): Theme | null {
  return parseTheme(store.get(THEME_COOKIE)?.value);
}

/** The `document.cookie` assignment that saves a choice for the whole site. */
export function themeCookie(theme: Theme, secure: boolean): string {
  const base = `${THEME_COOKIE}=${theme}; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax`;
  return secure ? `${base}; Secure` : base;
}

/** The theme on screen: a saved choice wins, else the OS setting. */
export function effectiveTheme(chosen: Theme | null, osDark: boolean): Theme {
  return chosen ?? (osDark ? "dark" : "light");
}

export function otherTheme(theme: Theme): Theme {
  return theme === "dark" ? "light" : "dark";
}
