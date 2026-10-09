import {
  INVALID_SPAN_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  trace,
  type Attributes,
  type Context,
  type Span,
} from "@opentelemetry/api";
import { MAX_CAPTURED_CHARS } from "./content.js";
import { telemetryState } from "./state.js";

const TRACER_NAME = "kobe";

/** Opaque ids only (never names, emails or content). */
export interface SpanIds {
  readonly teamId?: string | undefined;
  readonly userId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly runId?: string | undefined;
  readonly sandboxId?: string | undefined;
}

const ID_KEYS: Readonly<Record<keyof SpanIds, string>> = {
  teamId: "kobe.team_id",
  userId: "kobe.user_id",
  threadId: "kobe.thread_id",
  agentId: "kobe.agent_id",
  runId: "kobe.run_id",
  sandboxId: "kobe.sandbox_id",
};

export function idAttributes(ids: SpanIds): Attributes {
  const out: Attributes = {};
  for (const key of Object.keys(ID_KEYS) as (keyof SpanIds)[]) {
    const value = ids[key];
    if (value !== undefined && value !== "") out[ID_KEYS[key]] = value;
  }
  return out;
}

/** Content attributes: empty unless the install opted in to capture (and truncated when so). */
export function contentAttributes(values: Readonly<Record<string, string>>): Attributes {
  if (!telemetryState().captureContent) return {};
  const out: Attributes = {};
  for (const [k, v] of Object.entries(values)) out[k] = v.slice(0, MAX_CAPTURED_CHARS);
  return out;
}

/** Adds ids to the active span (no-op when tracing is off). */
export function annotate(ids: SpanIds, extra: Attributes = {}): void {
  if (!telemetryState().enabled) return;
  trace.getActiveSpan()?.setAttributes({ ...idAttributes(ids), ...extra });
}

export interface SpanOptions {
  readonly attributes?: Attributes;
  readonly kind?: SpanKind;
  /** Parent context (e.g. extracted from request headers); default: the active context. */
  readonly parent?: Context;
}

/**
 * Runs `fn` inside a span. Failures mark the span with the error's type only: messages can hold
 * content, so they are neither recorded nor attached as events.
 */
export async function withSpan<T>(
  name: string,
  options: SpanOptions,
  fn: (span: Span) => T | Promise<T>,
): Promise<T> {
  if (!telemetryState().enabled) return fn(trace.wrapSpanContext(INVALID_SPAN_CONTEXT));
  const parent = options.parent ?? context.active();
  const span = trace.getTracer(TRACER_NAME).startSpan(
    name,
    {
      kind: options.kind ?? SpanKind.INTERNAL,
      ...(options.attributes ? { attributes: options.attributes } : {}),
    },
    parent,
  );
  try {
    return await context.with(trace.setSpan(parent, span), () => fn(span));
  } catch (error) {
    markFailed(span, error);
    throw error;
  } finally {
    span.end();
  }
}

export function markFailed(span: Span, error: unknown): void {
  span.setAttribute("error.type", error instanceof Error ? error.constructor.name : "Error");
  span.setStatus({ code: SpanStatusCode.ERROR });
}

export { SpanKind, SpanStatusCode };

export interface FinishedSpan {
  readonly attributes?: Attributes;
  readonly startTime: number;
  readonly endTime?: number;
  readonly kind?: SpanKind;
  readonly error?: boolean;
  readonly parent?: Context;
}

/** Records a span for work that already finished (e.g. a connection reported once, at its end). */
export function recordSpan(name: string, finished: FinishedSpan): void {
  if (!telemetryState().enabled) return;
  const span = trace.getTracer(TRACER_NAME).startSpan(
    name,
    {
      kind: finished.kind ?? SpanKind.INTERNAL,
      startTime: finished.startTime,
      ...(finished.attributes ? { attributes: finished.attributes } : {}),
    },
    finished.parent ?? context.active(),
  );
  if (finished.error) span.setStatus({ code: SpanStatusCode.ERROR });
  span.end(finished.endTime ?? Date.now());
}
