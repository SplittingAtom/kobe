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

/** A copy of `headers` with the active trace context added (unchanged when tracing is off). */
export function injectTraceHeaders<T extends Record<string, string>>(headers: T): T {
  const out: Record<string, string> = { ...headers };
  if (telemetryState().enabled) propagation.inject(context.active(), out);
  return out as T;
}
