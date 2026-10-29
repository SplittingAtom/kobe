import type { SiteBranding } from "@kobe/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  BRANDING_CACHE_MS,
  BRANDING_LOG_INTERVAL_MS,
  createBrandingLoader,
  DEFAULT_BRANDING,
} from "./branding-server";

/** KOBE-500 (TH5, ac-3): fetch with a timeout, 30 s cache, defaults on failure, rate-limited log. */
const ACME: SiteBranding = {
  appName: "Acme",
  showName: false,
  logo: { url: "/v1/site/branding/assets/logo?v=ab", dark: "/v1/site/branding/assets/logo_dark?v=cd" },
  favicon: "/v1/site/branding/assets/favicon?v=ef",
  theme: { preset: "forest" },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function setup(respond: (url: string, init?: RequestInit) => Promise<Response>, timeoutMs?: number) {
  let t = 1_000_000;
  const lines: string[] = [];
  const fetchMock = vi.fn(respond);
  const load = createBrandingLoader({
    serverUrl: "http://kobe-server",
    fetch: fetchMock as unknown as typeof fetch,
    now: () => t,
    log: (line) => lines.push(line),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { load, fetchMock, lines, advance: (ms: number) => (t += ms) };
}

describe("getSiteBranding loader", () => {
  it("defaults are Kobe, the name shown, no assets, the default preset", () => {
    expect(DEFAULT_BRANDING).toEqual({
      appName: "Kobe",
      showName: true,
      logo: null,
      favicon: null,
      theme: { preset: "default" },
    });
  });

  it("fetches the server's public branding route and validates it", async () => {
    const { load, fetchMock } = setup(async () => json(ACME));
    expect(await load()).toEqual(ACME);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://kobe-server/v1/site/branding");
    expect(init?.cache).toBe("no-store");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("caches a success for 30 s and shares one request between concurrent renders", async () => {
    const { load, fetchMock, advance } = setup(async () => json(ACME));
    await Promise.all([load(), load(), load()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    advance(BRANDING_CACHE_MS - 1);
    await load();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    advance(1);
    await load();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("times out after the limit and serves the defaults", async () => {
    const { load, lines } = setup(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
      20,
    );
    expect(await load()).toEqual(DEFAULT_BRANDING);
    expect(lines).toEqual([
      "[kobe-web] site branding unavailable (timed out); serving the Kobe defaults",
    ]);
  });

  it.each([
    ["a refused connection", async () => Promise.reject(new TypeError("fetch failed")), /fetch failed/],
    ["an HTTP error", async () => json({ error: "nope" }, 503), /HTTP 503/],
    ["a body off the schema", async () => json({ ...ACME, css: "x" }), /schema/],
    ["not JSON", async () => new Response("<html>"), /JSON|Unexpected/],
    [
      "an off-site asset URL",
      async () => json({ ...ACME, favicon: "https://evil.example/x.ico" }),
      /same-origin/,
    ],
    ["a protocol-relative logo", async () => json({ ...ACME, logo: { url: "//evil.example/x" } }), /same-origin/],
  ])("falls back on %s", async (_name, respond, reason) => {
    const { load, lines } = setup(respond);
    expect(await load()).toEqual(DEFAULT_BRANDING);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(reason);
  });

  it("caches a failure for 30 s and logs at most once a minute", async () => {
    let up = false;
    const { load, fetchMock, lines, advance } = setup(async () =>
      up ? json(ACME) : Promise.reject(new TypeError("fetch failed")),
    );
    await load();
    await load();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    advance(BRANDING_CACHE_MS);
    await load();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lines).toHaveLength(1);
    advance(BRANDING_LOG_INTERVAL_MS - BRANDING_CACHE_MS);
    await load();
    expect(lines).toHaveLength(2);
    up = true;
    advance(BRANDING_CACHE_MS);
    expect(await load()).toEqual(ACME);
    expect(lines).toHaveLength(2);
  });

  it("without a server URL serves the defaults and never fetches or logs", async () => {
    const fetchMock = vi.fn();
    const lines: string[] = [];
    const load = createBrandingLoader({
      serverUrl: null,
      fetch: fetchMock as unknown as typeof fetch,
      log: (l) => lines.push(l),
    });
    expect(await load()).toEqual(DEFAULT_BRANDING);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });
});
