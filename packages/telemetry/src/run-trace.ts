import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  trace,
  type Attributes,
  type Context,
} from "@opentelemetry/api";
import { RandomIdGenerator, type IdGenerator } from "@opentelemetry/sdk-trace-base";
import {
  RUN_ROOT_SPAN_NAME,
  TRACE_SESSION_ID_ATTRIBUTE,
  TRACE_USER_ID_ATTRIBUTE,
  runRootSpanId,
  runTraceId,
} from "@kobe/protocol";
import { telemetryState } from "./state.js";

/**
 * Run traces (KOBE-274, `@kobe/protocol` tracing.ts): one run is one trace whose id is the run
 * id's hex digits, under a root span `kobe.run` with a fixed id, so every replica and the model
 * gateway place spans in it without a lookup.
 */

/**
 * Random ids, except while {@link recordRunRootSpan} starts a run's root span: then the run's
 * fixed trace and span id. Set and cleared synchronously around one `startSpan`.
 */
export class RunIdGenerator implements IdGenerator {
  readonly #random = new RandomIdGenerator();
  #next: { readonly traceId: string; readonly spanId: string } | undefined;

  generateTraceId(): string {
    return this.#next?.traceId ?? this.#random.generateTraceId();
  }

  generateSpanId(): string {
    return this.#next?.spanId ?? this.#random.generateSpanId();
  }

  withIds<T>(ids: { readonly traceId: string; readonly spanId: string }, fn: () => T): T {
    this.#next = ids;
    try {
      return fn();
    } finally {
      this.#next = undefined;
    }
  }
}

let generator: RunIdGenerator | undefined;

export function setRunIdGenerator(next: RunIdGenerator | undefined): void {
  generator = next;
}

/**
 * The context to start a span of run `runId` under: its trace, parent = `parentSpanId` (default:
 * the root span `kobe.run`). Returns the active context unchanged when tracing is off.
 */
export function runParentContext(runId: string, parentSpanId?: string): Context {
  if (!telemetryState().enabled) return ROOT_CONTEXT;
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: runTraceId(runId),
    spanId: parentSpanId ?? runRootSpanId(runId),
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });
}

export interface RunRootSpan {
  readonly runId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly attributes: Attributes;
  readonly error?: boolean;
}

/** Records a run's root span `kobe.run` (fixed ids) once the run is over. */
export function recordRunRootSpan(root: RunRootSpan): void {
  if (!telemetryState().enabled || generator === undefined) return;
  const ids = { traceId: runTraceId(root.runId), spanId: runRootSpanId(root.runId) };
  const span = generator.withIds(ids, () =>
    trace
      .getTracer("kobe")
      .startSpan(
        RUN_ROOT_SPAN_NAME,
        { kind: SpanKind.INTERNAL, startTime: root.startMs, attributes: root.attributes },
        ROOT_CONTEXT,
      ),
  );
  if (root.error) span.setStatus({ code: SpanStatusCode.ERROR });
  span.end(Math.max(root.endMs, root.startMs));
}

/** Langfuse session attributes of a run's spans: `session.id` = thread, `user.id` = its owner. */
export function sessionAttributes(session: {
  readonly threadId: string;
  readonly userId: string;
}): Attributes {
  return {
    [TRACE_SESSION_ID_ATTRIBUTE]: session.threadId,
    [TRACE_USER_ID_ATTRIBUTE]: session.userId,
  };
}
