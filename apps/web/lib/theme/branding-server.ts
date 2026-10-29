import { type SiteBranding, siteBrandingSchema } from "@kobe/protocol";
import { webConfig } from "../config";
import { isSameOriginPath } from "../security/same-origin-path";
import { DEFAULT_BRANDING } from "./branding-defaults";

export { DEFAULT_BRANDING };

/**
 * The site branding for the server render (theming plan TH5; server only: the root layout and
 * generateMetadata call it), from `GET ${KOBE_SERVER_URL}/v1/site/branding` with a 1 s timeout.
 *
 * Stale-while-revalidate per web process: the last validated value is kept; once it is 30 s old
 * the next render starts ONE background refresh and is served the kept value at once, so no
 * render waits on the server except the very first (≤ 1 s, then the defaults). A failed refresh
 * never replaces a known-good value: it is logged (at most once a minute) and retried 30 s later.
 * The URL is the deployment's, never a request's.
 *
 * The response is validated with the protocol schema, and its asset URLs must be same-origin paths
 * (`/v1/site/branding/assets/…`): they become `<img src>` and `<link rel=icon>` on every page.
 */

export const BRANDING_TIMEOUT_MS = 1000;
export const BRANDING_CACHE_MS = 30_000;
export const BRANDING_LOG_INTERVAL_MS = 60_000;
export const BRANDING_PATH = "/v1/site/branding";

export interface BrandingLoaderOptions {
  /** The server's origin, or null when unconfigured (then always the defaults, nothing logged). */
  readonly serverUrl: string | null;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  readonly timeoutMs?: number;
}

/** Loads the branding; `invalidate()` refetches it now (after an admin's change, KOBE-501). */
export type BrandingLoader = (() => Promise<SiteBranding>) & {
  readonly invalidate: () => Promise<void>;
};

function assetsSameOrigin(b: SiteBranding): boolean {
  const urls = [b.logo?.url, b.logo?.dark, b.favicon].filter((u): u is string => u != null);
  return urls.every(isSameOriginPath);
}

async function fetchBranding(
  url: string,
  doFetch: typeof fetch,
  timeoutMs: number,
): Promise<SiteBranding> {
  const response = await doFetch(url, {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const parsed = siteBrandingSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("the response does not match the branding schema");
  if (!assetsSameOrigin(parsed.data)) throw new Error("an asset URL is not a same-origin path");
  return parsed.data;
}

function reasonOf(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "TimeoutError" ? "timed out" : error.message || error.name;
  }
  return String(error);
}

/** A stale-while-revalidate loader; exported for tests, the app uses {@link getSiteBranding}. */
export function createBrandingLoader(options: BrandingLoaderOptions): BrandingLoader {
  const { serverUrl } = options;
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.warn(line));
  const timeoutMs = options.timeoutMs ?? BRANDING_TIMEOUT_MS;
  /** The last validated branding; never replaced by a failure. */
  let good: SiteBranding | undefined;
  /** When the last attempt (success or failure) started; the next is due BRANDING_CACHE_MS later. */
  let attemptedAt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<void> | undefined;
  let lastLog = Number.NEGATIVE_INFINITY;

  const refresh = (): Promise<void> => {
    inflight ??= (async () => {
      attemptedAt = now();
      try {
        good = await fetchBranding(`${serverUrl}${BRANDING_PATH}`, doFetch, timeoutMs);
      } catch (error) {
        const at = now();
        if (at - lastLog >= BRANDING_LOG_INTERVAL_MS) {
          lastLog = at;
          const serving = good === undefined ? "the Kobe defaults" : "the last known branding";
          log(`[kobe-web] site branding unavailable (${reasonOf(error)}); serving ${serving}`);
        }
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  };

  const load = async () => {
    if (serverUrl === null) return DEFAULT_BRANDING;
    const due = now() - attemptedAt >= BRANDING_CACHE_MS;
    if (good !== undefined) {
      if (due) void refresh();
      return good;
    }
    // Nothing known yet: the first load (or a retry 30 s after a failed one) waits, ≤ timeoutMs.
    if (due || inflight !== undefined) await refresh();
    return good ?? DEFAULT_BRANDING;
  };

  /**
   * Refetches now, whatever the cache's age. A fetch already in flight may predate the change, so
   * a new one starts after it. A failure keeps the last good value (as every refresh does).
   */
  const invalidate = async (): Promise<void> => {
    if (serverUrl === null) return;
    if (inflight !== undefined) await inflight;
    await refresh();
  };

  return Object.assign(load, { invalidate });
}

let loader: BrandingLoader | undefined;

function siteLoader(): BrandingLoader {
  loader ??= createBrandingLoader({ serverUrl: webConfig().serverUrl });
  return loader;
}

/** The site branding for this render: never throws, never waits on a refresh once known. */
export function getSiteBranding(): Promise<SiteBranding> {
  return siteLoader()();
}

/** Refetches this web process's branding now (`POST /api/branding/refresh`, KOBE-501). */
export function invalidateBranding(): Promise<void> {
  return siteLoader().invalidate();
}
