import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

/** A page of apps/web/app (KOBE-525 measurement run). */
export interface PageRoute {
  readonly route: string;
  /** Has a `[param]`: needs a real id to visit (bundle size only unless one is given). */
  readonly dynamic: boolean;
  /** Visited without a session (the sign-in and recovery pages). */
  readonly signedOut: boolean;
}

const SIGNED_OUT = new Set([
  "/sign-in",
  "/forgot-password",
  "/reset-password",
  "/invite",
  "/setup",
]);

/** `page.tsx` paths relative to app/ → routes, sorted; route groups `(x)` are not in the URL. */
export function routesFromPages(files: readonly string[]): PageRoute[] {
  const routes = files
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => f === "page.tsx" || f.endsWith("/page.tsx"))
    .map((f) => {
      const segments = f
        .split("/")
        .slice(0, -1)
        .filter((s) => !(s.startsWith("(") && s.endsWith(")")));
      const route = `/${segments.join("/")}`;
      return { route, dynamic: route.includes("["), signedOut: SIGNED_OUT.has(route) };
    });
  return routes.sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0));
}

/** Every `page.tsx` under `appDir`, relative to it. */
export function listPages(appDir: string): string[] {
  return readdirSync(appDir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith("page.tsx"))
    .map((f) => relative(appDir, join(appDir, f)));
}
