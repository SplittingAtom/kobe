/**
 * Web Vitals reports (KOBE-525): what the browser sends to `POST /v1/telemetry/web-vitals`, where
 * the server turns each into a span on its telemetry. Metadata only: the metric, its value and
 * rating, and the page's route template (ids folded), never the page's content or query.
 */

export const WEB_VITAL_NAMES = [
  "TTFB",
  "FCP",
  "LCP",
  "INP",
  "CLS",
  "FID",
  "Next.js-hydration",
  "Next.js-route-change-to-render",
  "Next.js-render",
] as const;

export type WebVitalName = (typeof WEB_VITAL_NAMES)[number];

const NAVIGATION_TYPES = new Set([
  "navigate",
  "reload",
  "back-forward",
  "back-forward-cache",
  "prerender",
  "restore",
]);
const RATINGS = new Set(["good", "needs-improvement", "poor"]);

export interface VitalReport {
  readonly name: WebVitalName;
  readonly value: number;
  readonly route: string;
  readonly rating?: string;
  readonly navigation_type?: string;
}

/** The fields of Next's `useReportWebVitals` metric this module reads. */
export interface VitalMetric {
  readonly name: string;
  readonly value: number;
  readonly rating?: string | undefined;
  readonly navigationType?: string | undefined;
}

/** Signed-out pages: the endpoint needs a session, so they report nothing (Playwright covers them). */
const SIGNED_OUT = ["/sign-in", "/forgot-password", "/reset-password", "/invite", "/setup"];

export function isReportedRoute(pathname: string): boolean {
  return !SIGNED_OUT.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

const WORD = /^[a-z][a-z0-9-]{0,39}$/;

/** A pathname as a route template: segments that are not plain lowercase words become `[id]`. */
export function routeTemplate(pathname: string): string {
  const segments = pathname.split("/").filter((s) => s !== "");
  const kept = segments.map((s) => (WORD.test(s) && !/\d{3,}/.test(s) ? s : "[id]"));
  return `/${kept.join("/")}`;
}

const KNOWN: ReadonlySet<string> = new Set(WEB_VITAL_NAMES);

export function toReport(metric: VitalMetric, pathname: string): VitalReport | undefined {
  if (!KNOWN.has(metric.name) || !Number.isFinite(metric.value) || metric.value < 0) {
    return undefined;
  }
  return {
    name: metric.name as WebVitalName,
    value: metric.value,
    route: routeTemplate(pathname),
    ...(metric.rating !== undefined && RATINGS.has(metric.rating) ? { rating: metric.rating } : {}),
    ...(metric.navigationType !== undefined && NAVIGATION_TYPES.has(metric.navigationType)
      ? { navigation_type: metric.navigationType }
      : {}),
  };
}

/** Reports per request (the server takes up to 20). */
export const VITALS_FLUSH_AT = 10;

export interface VitalsQueue {
  add(report: VitalReport): void;
  /** Sends what is queued (page hidden, timer); a failed send drops the batch. */
  flush(): void;
}

export function createVitalsQueue(send: (reports: readonly VitalReport[]) => void): VitalsQueue {
  let queued: readonly VitalReport[] = [];
  const flush = () => {
    if (queued.length === 0) return;
    const batch = queued;
    queued = [];
    try {
      send(batch);
    } catch {
      // Telemetry never breaks the page.
    }
  };
  return {
    add(report) {
      queued = [...queued, report];
      if (queued.length >= VITALS_FLUSH_AT) flush();
    },
    flush,
  };
}

/** The browser's send: a keepalive POST, so a report outlives the page it describes. */
export function postVitals(reports: readonly VitalReport[]): void {
  void fetch("/v1/telemetry/web-vitals", {
    method: "POST",
    credentials: "same-origin",
    keepalive: true,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reports }),
  }).catch(() => undefined);
}
