/** Console URLs (KOBE-257), free of the section registry so next.config.ts can import them. */
import type { ConsoleKind } from "./types";

export const CONSOLE_BASE = "/admin";

/** URL segment per console: the install console is served as the Site console. */
export const CONSOLE_SEGMENTS: Readonly<Record<ConsoleKind, string>> = {
  install: "site",
  team: "team",
};

/** Segments a rename retired, with the console each now redirects to (old links keep working). */
export const RETIRED_CONSOLE_SEGMENTS: Readonly<Record<string, ConsoleKind>> = {
  install: "install",
};

export function consoleHref(kind: ConsoleKind): string {
  return `${CONSOLE_BASE}/${CONSOLE_SEGMENTS[kind]}`;
}

export interface ConsoleRedirect {
  readonly source: string;
  readonly destination: string;
  readonly permanent: true;
}

/** One permanent redirect per retired segment; `:path*` also matches the bare console URL. */
export function consoleRedirects(): ConsoleRedirect[] {
  return Object.entries(RETIRED_CONSOLE_SEGMENTS).map(([old, kind]) => ({
    source: `${CONSOLE_BASE}/${old}/:path*`,
    destination: `${consoleHref(kind)}/:path*`,
    permanent: true,
  }));
}
