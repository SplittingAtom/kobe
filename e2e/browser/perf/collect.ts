import type { Page } from "@playwright/test";
import type { MetricKey } from "./table.ts";

/** How long a loaded page is left alone before reading its timings (LCP and CLS settle). */
const SETTLE_MS = 1_500;

/**
 * One page load's timings from the Performance API (KOBE-525): TTFB, DOM ready and load from the
 * navigation entry, FCP from paint, LCP and CLS from buffered observers. INP needs real input, so
 * it comes from the field data (the web's reporter → server spans), not from here.
 */
export async function measureLoad(
  page: Page,
  path: string,
): Promise<Partial<Record<MetricKey, number>>> {
  await page.goto(path, { waitUntil: "load" });
  await page.waitForTimeout(SETTLE_MS);
  return page.evaluate(
    () =>
      new Promise<Partial<Record<string, number>>>((resolve) => {
        const nav = performance.getEntriesByType("navigation")[0] as
          PerformanceNavigationTiming | undefined;
        const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime;
        let lcp: number | undefined;
        let cls = 0;
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) lcp = e.startTime;
        }).observe({ type: "largest-contentful-paint", buffered: true });
        new PerformanceObserver((list) => {
          for (const e of list.getEntries() as (PerformanceEntry & {
            value: number;
            hadRecentInput: boolean;
          })[]) {
            if (!e.hadRecentInput) cls += e.value;
          }
        }).observe({ type: "layout-shift", buffered: true });
        setTimeout(
          () =>
            resolve({
              ttfb: nav?.responseStart,
              fcp,
              lcp,
              cls,
              dcl: nav?.domContentLoadedEventEnd,
              load: nav?.loadEventEnd,
            }),
          100,
        );
      }),
  ) as Promise<Partial<Record<MetricKey, number>>>;
}
