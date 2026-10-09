import type { MiddlewareHandler } from "hono";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { contentAttributes, withSpan } from "./spans.js";
import { extractContext } from "./propagation.js";
import { telemetryState } from "./state.js";

const asNumber = (v: string | null | undefined): number | undefined => {
  const n = v === null || v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * One server span per request: method, route template (never the raw path), status, sizes. Joins
 * the caller's trace from `traceparent`. The query string is content (it can carry tokens) and is
 * recorded only with capture on. Streaming responses end the span when headers are sent.
 */
export function honoTracing(): MiddlewareHandler {
  return async (c, next) => {
    if (!telemetryState().enabled) return next();
    const method = c.req.method;
    const query = new URL(c.req.url, "http://x").search.slice(1);
    await withSpan(
      method,
      {
        kind: SpanKind.SERVER,
        parent: extractContext(c.req.header()),
        attributes: {
          "http.request.method": method,
          ...(asNumber(c.req.header("content-length")) === undefined
            ? {}
            : { "http.request.body.size": asNumber(c.req.header("content-length")) as number }),
          ...(query === "" ? {} : contentAttributes({ "url.query": query })),
        },
      },
      async (span) => {
        await next();
        const status = c.res.status;
        const route = c.req.routePath;
        span.updateName(route && route !== "/*" ? `${method} ${route}` : method);
        span.setAttribute("http.response.status_code", status);
        if (route && route !== "/*") span.setAttribute("http.route", route);
        const size = asNumber(c.res.headers.get("content-length"));
        if (size !== undefined) span.setAttribute("http.response.body.size", size);
        if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      },
    );
  };
}
