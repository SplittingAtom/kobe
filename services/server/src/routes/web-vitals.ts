import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { recordSpan } from "@kobe/telemetry";
import { z } from "zod";
import type { AuthVariables } from "../auth/session.js";
import { createRateLimiter, type RateLimiter } from "../sandbox/rate-limit.js";
import { invalidRequest, parseBody } from "../teams/http.js";

/**
 * Web Vitals from the browser (KOBE-525): `POST /v1/telemetry/web-vitals`, mounted on
 * `/v1/telemetry` behind the session check. Each report becomes one span on the server's
 * telemetry (OTLP → the trace backend), named `web.vital <metric> <route>` and lasting the
 * metric's value, so percentiles per route need only span names and times. Metadata only: the
 * route template (ids folded), the metric, its rating; never the user's content or ids.
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

/** A batch of a few reports fits easily; anything larger is not the web's reporter. */
export const WEB_VITALS_MAX_BODY = 4 * 1024;
const MAX_REPORTS = 20;
/** Longest value accepted (ms): ten minutes. */
const MAX_VALUE = 600_000;
/** CLS is a unitless score: its span lasts 1000 × the score (milli-CLS). */
const CLS_SCALE = 1000;
const MAX_SEGMENTS = 8;
const SEGMENT = /^[a-z][a-z0-9-]{0,39}$/;
const PLACEHOLDER = /^\[(\.\.\.)?[a-zA-Z]{1,16}\]$/;

/** Per user: a page reports a handful of metrics per navigation. */
const WEB_VITALS_RATE = { capacity: 60, refillPerSecond: 1 };

const reportSchema = z.strictObject({
  name: z.enum(WEB_VITAL_NAMES),
  value: z.number().finite().min(0).max(MAX_VALUE),
  route: z.string().min(1).max(256),
  rating: z.enum(["good", "needs-improvement", "poor"]).optional(),
  navigation_type: z
    .enum(["navigate", "reload", "back-forward", "back-forward-cache", "prerender", "restore"])
    .optional(),
});

const bodySchema = z.strictObject({ reports: z.array(reportSchema).min(1).max(MAX_REPORTS) });

/**
 * A page path as a route template: query and hash dropped, every segment that is not a plain
 * lowercase word or a `[param]` placeholder becomes `[id]`; anything else is `other`.
 */
export function normalizeRoute(path: string): string {
  const bare = path.split(/[?#]/, 1)[0] ?? "";
  if (!bare.startsWith("/")) return "other";
  const segments = bare.split("/").filter((s) => s !== "");
  if (segments.length > MAX_SEGMENTS) return "other";
  const kept = segments.map((s) =>
    (SEGMENT.test(s) && !/\d{3,}/.test(s)) || PLACEHOLDER.test(s) ? s : "[id]",
  );
  return `/${kept.join("/")}`;
}

export interface WebVitalsOptions {
  readonly limiter?: RateLimiter;
  readonly now?: () => number;
}

export function webVitalsRoutes(
  options: WebVitalsOptions = {},
): Hono<{ Variables: AuthVariables }> {
  const limiter = options.limiter ?? createRateLimiter(WEB_VITALS_RATE);
  const now = options.now ?? Date.now;
  const app = new Hono<{ Variables: AuthVariables }>();
  app.post(
    "/web-vitals",
    bodyLimit({
      maxSize: WEB_VITALS_MAX_BODY,
      onError: (c) => c.json({ code: "too_large", message: "The request is too large." }, 413),
    }),
    async (c) => {
      const waitMs = limiter.take(c.get("user").id);
      if (waitMs > 0) {
        c.header("Retry-After", String(Math.ceil(waitMs / 1000)));
        return c.json(
          { code: "rate_limited", message: "Too many requests. Try again later." },
          429,
        );
      }
      const body = await parseBody(c, bodySchema);
      if (!body) return invalidRequest(c, "Send {reports: [{name, value, route}]}.");
      const end = now();
      for (const report of body.reports) {
        const route = normalizeRoute(report.route);
        const ms = report.name === "CLS" ? report.value * CLS_SCALE : report.value;
        recordSpan(`web.vital ${report.name} ${route}`, {
          startTime: end - ms,
          endTime: end,
          attributes: {
            "kobe.web_vital.name": report.name,
            "kobe.web_vital.value": report.value,
            "http.route": route,
            ...(report.rating === undefined ? {} : { "kobe.web_vital.rating": report.rating }),
            ...(report.navigation_type === undefined
              ? {}
              : { "kobe.web_vital.navigation_type": report.navigation_type }),
          },
        });
      }
      return c.body(null, 204);
    },
  );
  return app;
}
