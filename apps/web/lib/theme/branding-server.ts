import { type SiteBranding, siteBrandingSchema } from "@kobe/protocol";
import { webConfig } from "../config";
import { DEFAULT_BRANDING } from "./branding-defaults";

export { DEFAULT_BRANDING };

/**
 * The site branding for the server render (theming plan TH5; server only: the root layout and
 * generateMetadata call it). One `GET ${KOBE_SERVER_URL}/v1/site/branding` per 30 s per web
 * process, 1 s timeout; a failure is cached for the same 30 s, so an unreachable server costs at
 * most one slow render per window. Every failure yields {@link DEFAULT_BRANDING} (never a failed
 * page) and is logged at most once a minute. The URL is the deployment's, never a request's.
 *
 * The response is validated with the protocol schema, and its asset URLs must be same-origin paths
 * (`/v1/site/branding/assets/…`): they become `<img src>` and `<link rel=icon>` on every page.
 */

export const BRANDING_TIMEOUT_MS = 1000;
export const BRANDING_CACHE_MS = 30_000;
export const BRANDING_LOG_INTERVAL_MS = 60_000;
export const BRANDING_PATH = "/v1/site/branding";

/** A path on this origin (`/x`, not `//host` or `/\host`). */
const SAME_ORIGIN_PATH = /^\/(?![/\\])[^\s\\]*$/;

export interface BrandingLoaderOptions {
  /** The server's origin, or null when unconfigured (then always the defaults, nothing logged). */
  readonly serverUrl: string | null;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  readonly timeoutMs?: number;
}

export type BrandingLoader = () => Promise<SiteBranding>;

function assetsSameOrigin(b: SiteBranding): boolean {
  const urls = [b.logo?.url, b.logo?.dark, b.favicon].filter((u): u is string => u != null);
  return urls.every((u) => SAME_ORIGIN_PATH.test(u));
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

/** A cached loader; exported for tests, the app uses {@link getSiteBranding}. */
export function createBrandingLoader(options: BrandingLoaderOptions): BrandingLoader {
  const { serverUrl } = options;
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.warn(line));
  const timeoutMs = options.timeoutMs ?? BRANDING_TIMEOUT_MS;
  let cached: { value: SiteBranding; expires: number } | undefined;
  let inflight: Promise<SiteBranding> | undefined;
  let lastLog = Number.NEGATIVE_INFINITY;

  const load = async (): Promise<SiteBranding> => {
    let value: SiteBranding;
    try {
      value = await fetchBranding(`${serverUrl}${BRANDING_PATH}`, doFetch, timeoutMs);
    } catch (error) {
      value = DEFAULT_BRANDING;
      const at = now();
      if (at - lastLog >= BRANDING_LOG_INTERVAL_MS) {
        lastLog = at;
        log(`[kobe-web] site branding unavailable (${reasonOf(error)}); serving the Kobe defaults`);
      }
    }
    cached = { value, expires: now() + BRANDING_CACHE_MS };
    return value;
  };

  return async () => {
    if (serverUrl === null) return DEFAULT_BRANDING;
    if (cached !== undefined && now() < cached.expires) return cached.value;
    inflight ??= load().finally(() => {
      inflight = undefined;
    });
    return inflight;
  };
}

let loader: BrandingLoader | undefined;

/** The site branding for this render: cached, never throws. */
export function getSiteBranding(): Promise<SiteBranding> {
  loader ??= createBrandingLoader({ serverUrl: webConfig().serverUrl });
  return loader();
}
