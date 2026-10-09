import type { IncomingMessage, ServerResponse } from "node:http";
import { SpanKind, SpanStatusCode, context, trace } from "@opentelemetry/api";
import { extractContext } from "./propagation.js";
import { contentAttributes } from "./spans.js";
import { telemetryState } from "./state.js";

const sizeOf = (v: string | string[] | number | undefined): number | undefined => {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return v !== undefined && Number.isFinite(n) ? n : undefined;
};

/**
 * Wraps a `node:http` handler (gateway, egress proxy) with a server span that ends when the
 * response is closed and the handler has settled. `name` is a fixed label (no path), so cardinality stays low; the raw URL is never
 * recorded, the query only with content capture. `annotate`/`withSpan` inside the handler see it.
 */
export function traceNodeRequest<T>(
  name: string,
  req: IncomingMessage,
  res: ServerResponse,
  handler: () => T,
): T {
  if (!telemetryState().enabled) return handler();
  const parent = extractContext(req.headers);
  const query = (req.url ?? "").split("?")[1] ?? "";
  const reqSize = sizeOf(req.headers["content-length"]);
  const span = trace.getTracer("kobe").startSpan(
    name,
    {
      kind: SpanKind.SERVER,
      attributes: {
        "http.request.method": req.method ?? "UNKNOWN",
        ...(reqSize === undefined ? {} : { "http.request.body.size": reqSize }),
        ...(query === "" ? {} : contentAttributes({ "url.query": query })),
      },
    },
    parent,
  );
  // The span ends once the response is closed and the handler has settled, so a handler's final
  // annotations (usage, outcome) land on it.
  let closed = false;
  let settled = false;
  const finish = () => {
    if (closed && settled) span.end();
  };
  res.once("close", () => {
    closed = true;
    span.setAttribute("http.response.status_code", res.statusCode);
    const size = sizeOf(res.getHeader("content-length"));
    if (size !== undefined) span.setAttribute("http.response.body.size", size);
    if (res.statusCode >= 500 || !res.writableFinished) {
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    finish();
  });
  const result = context.with(trace.setSpan(parent, span), handler);
  const settle = () => {
    settled = true;
    finish();
  };
  if (result instanceof Promise) result.then(settle, settle);
  else settle();
  return result;
}
