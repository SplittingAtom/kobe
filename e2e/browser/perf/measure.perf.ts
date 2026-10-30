import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "@playwright/test";
import { readBundleSizes, type BundleSize } from "./bundles.ts";
import { measureLoad } from "./collect.ts";
import { listPages, routesFromPages, type PageRoute } from "./routes.ts";
import { aggregate, renderTable, type Visit } from "./table.ts";

/**
 * The web measurement run (KOBE-525 ac-1), on demand against a deployment, never in CI:
 * every page under apps/web/app is loaded KOBE_PERF_RUNS times (signed-out pages without the
 * session), and a markdown table of p50 / p95 per metric and route is written with each route's
 * first-load JS from the local `next build`. See docs/perf-baseline-2026-10-30.md.
 */
const APP_DIR = resolve(process.env["KOBE_PERF_APP_DIR"] ?? "../../apps/web");
const RUNS = Number(process.env["KOBE_PERF_RUNS"] ?? 5);
const OUT =
  process.env["KOBE_PERF_OUT"] ?? `perf-results/web-${new Date().toISOString().slice(0, 10)}.md`;
/** Optional filter: comma-separated routes. */
const ONLY = process.env["KOBE_PERF_ROUTES"]?.split(",").filter((r) => r !== "");
/** Optional JSON {"/me/agents/[id]": "/me/agents/<uuid>"}: concrete paths for dynamic routes. */
const IDS = JSON.parse(process.env["KOBE_PERF_IDS"] ?? "{}") as Record<string, string>;

function bundles(): Record<string, BundleSize> {
  try {
    return readBundleSizes(APP_DIR);
  } catch {
    return {}; // no local build: the bundle column stays empty
  }
}

const visitable = (r: PageRoute) => !r.dynamic || IDS[r.route] !== undefined;

test("web route timings", async ({ page, browser }) => {
  const routes = routesFromPages(listPages(`${APP_DIR}/app`)).filter(
    (r) => !ONLY || ONLY.includes(r.route),
  );
  test.setTimeout(Math.max(60_000, routes.length * RUNS * 30_000));
  const signedOut = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const visits: Visit[] = [];
  try {
    for (const r of routes.filter(visitable)) {
      const target = r.signedOut ? await signedOut.newPage() : page;
      for (let i = 0; i < RUNS; i++) {
        const metrics = await measureLoad(target, IDS[r.route] ?? r.route).catch(() => undefined);
        if (metrics) visits.push({ route: r.route, metrics });
      }
      if (r.signedOut) await target.close();
    }
  } finally {
    await signedOut.close();
  }
  const unvisited = routes.filter((r) => !visitable(r)).map((r) => r.route);
  const table = renderTable(aggregate(visits, bundles(), unvisited));
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, table);
  writeFileSync(OUT.replace(/\.md$/, ".json"), JSON.stringify(visits, null, 2));
  console.log(`wrote ${OUT} (${visits.length} page loads, ${routes.length} routes)`);
});
