import type { Context as HonoContext, MiddlewareHandler } from "hono";
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, context, trace } from "@opentelemetry/api";
import { contentAttributes, markFailed } from "./spans.js";
import { extractContext } from "./propagation.js";
import { telemetryState } from "./state.js";

const asNumber = (v: string | null | undefined): number | undefined => {
  const n = v === null || v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export interface HonoTracingOptions {
  /**
   * Join the caller's trace from `traceparent` (default true). False for every listener a sandbox
   * can reach (KOBE-274): run trace ids are predictable, so a sandbox could write into any run's
   * trace; those listeners always start a fresh trace.
   */
  readonly joinCallerTrace?: boolean;
}

/** Requests whose handler asked for no trace (KOBE-417); keyed by the request, so nothing leaks. */
const skipped = new WeakSet<Request>();

/**
 * Leaves this request out of tracing: its span is never ended, so it is never exported. For
 * routine, high-volume answers only (KOBE-417: a warm-pool sandbox polling for its claim); the
 * handler must not have started child spans. A request that then fails (throws, or answers 5xx)
 * is still traced.
 */
export function skipRequestTrace(c: HonoContext): void {
  skipped.add(c.req.raw);
}

const TRACER_NAME = "kobe";

/**
 * One server span per request: method, route template (never the raw path), status, sizes. Joins
 * the caller's trace from `traceparent` unless told not to. The query string is content (it can
 * carry tokens) and is recorded only with capture on. Streaming responses end the span when
 * headers are sent.
 */
export function honoTracing(options: HonoTracingOptions = {}): MiddlewareHandler {
  const join = options.joinCallerTrace ?? true;
  return async (c, next) => {
    if (!telemetryState().enabled) return next();
    const method = c.req.method;
    const query = new URL(c.req.url, "http://x").search.slice(1);
    const parent = join ? extractContext(c.req.header()) : ROOT_CONTEXT;
    const span = trace.getTracer(TRACER_NAME).startSpan(
      method,
      {
        kind: SpanKind.SERVER,
        attributes: {
          "http.request.method": method,
          ...(asNumber(c.req.header("content-length")) === undefined
            ? {}
            : { "http.request.body.size": asNumber(c.req.header("content-length")) as number }),
          ...(query === "" ? {} : contentAttributes({ "url.query": query })),
        },
      },
      parent,
    );
    try {
      await context.with(trace.setSpan(parent, span), next);
    } catch (error) {
      markFailed(span, error);
      span.end();
      throw error;
    }
    const status = c.res.status;
    // Not ended → never handed to the span processor (KOBE-417). Errors stay traced.
    if (status < 500 && skipped.has(c.req.raw)) return;
    const route = c.req.routePath;
    span.updateName(route && route !== "/*" ? `${method} ${route}` : method);
    span.setAttribute("http.response.status_code", status);
    if (route && route !== "/*") span.setAttribute("http.route", route);
    const size = asNumber(c.res.headers.get("content-length"));
    if (size !== undefined) span.setAttribute("http.response.body.size", size);
    if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
  };
}
