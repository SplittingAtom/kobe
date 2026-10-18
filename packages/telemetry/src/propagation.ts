import { context, propagation, type Context } from "@opentelemetry/api";
import { telemetryState } from "./state.js";

type HeaderValue = string | string[] | undefined;

/** Parent context from incoming headers (Node `IncomingHttpHeaders` or a plain record). */
export function extractContext(headers: Readonly<Record<string, HeaderValue>>): Context {
  if (!telemetryState().enabled) return context.active();
  return propagation.extract(context.active(), headers, {
    keys: () => ["traceparent", "tracestate"],
    get: (carrier, key) => {
      const v = carrier[key];
      return Array.isArray(v) ? v[0] : v;
    },
  });
}

/**
 * A copy of `headers` with the trace context of `ctx` (default: the active one) added; unchanged
 * when tracing is off.
 */
export function injectTraceHeaders<T extends Record<string, string>>(
  headers: T,
  ctx: Context = context.active(),
): T {
  const out: Record<string, string> = { ...headers };
  if (telemetryState().enabled) propagation.inject(ctx, out);
  return out as T;
}
