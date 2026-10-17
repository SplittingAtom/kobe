import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  trace,
  type Attributes,
  type Context,
  type Span,
} from "@opentelemetry/api";
import { contentAttributes } from "./spans.js";
import { telemetryState } from "./state.js";

const sizeOf = (v: string | string[] | number | undefined): number | undefined => {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return v !== undefined && Number.isFinite(n) ? n : undefined;
};

/**
 * A request's server span, opened once the handler knows where it belongs (KOBE-274: the model
 * gateway places `model_gateway.request` in the attributed run's trace, which it only knows after
 * authenticating the call). Never opened by the handler: a fresh trace at the end.
 */
export interface RequestSpan {
  /** Starts the span under `parent` (default: a fresh trace); the first call wins. */
  open(parent?: Context): Context;
  /** Adds attributes (kept until the span opens). */
  setAttributes(attributes: Attributes): void;
}

const NOOP: RequestSpan = {
  open: () => context.active(),
  setAttributes: () => undefined,
};

/**
 * Wraps a `node:http` handler (the model gateway) with a server span that ends when the response
 * is closed and the handler has settled. **Never joins the caller's trace** (a sandbox can reach
 * this listener and run trace ids are predictable, KOBE-274): the handler opens the span under a
 * parent it decided, else it is a fresh trace. `name` is a fixed label (no path); the raw URL is
 * never recorded, the query only with content capture.
 */
export function traceNodeRequest<T>(
  name: string,
  req: IncomingMessage,
  res: ServerResponse,
  handler: (span: RequestSpan) => T,
): T {
  if (!telemetryState().enabled) return handler(NOOP);
  const startTime = Date.now();
  const query = (req.url ?? "").split("?")[1] ?? "";
  const reqSize = sizeOf(req.headers["content-length"]);
  let span: Span | undefined;
  let spanContext: Context = ROOT_CONTEXT;
  let pending: Attributes = {};
  const requestSpan: RequestSpan = {
    open(parent = ROOT_CONTEXT) {
      if (span) return spanContext;
      span = trace.getTracer("kobe").startSpan(
        name,
        {
          kind: SpanKind.SERVER,
          startTime,
          attributes: {
            "http.request.method": req.method ?? "UNKNOWN",
            ...(reqSize === undefined ? {} : { "http.request.body.size": reqSize }),
            ...(query === "" ? {} : contentAttributes({ "url.query": query })),
            ...pending,
          },
        },
        parent,
      );
      pending = {};
      spanContext = trace.setSpan(parent, span);
      return spanContext;
    },
    setAttributes(attributes) {
      if (span) span.setAttributes(attributes);
      else pending = { ...pending, ...attributes };
    },
  };
  let closed = false;
  let settled = false;
  let status = 0;
  let size: number | undefined;
  let failed = false;
  const finish = () => {
    if (!closed || !settled) return;
    requestSpan.open();
    if (!span) return;
    span.setAttribute("http.response.status_code", status);
    if (size !== undefined) span.setAttribute("http.response.body.size", size);
    if (failed) span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
  };
  res.once("close", () => {
    closed = true;
    status = res.statusCode;
    size = sizeOf(res.getHeader("content-length"));
    failed = res.statusCode >= 500 || !res.writableFinished;
    finish();
  });
  const result = handler(requestSpan);
  const settle = () => {
    settled = true;
    finish();
  };
  if (result instanceof Promise) result.then(settle, settle);
  else settle();
  return result;
}
