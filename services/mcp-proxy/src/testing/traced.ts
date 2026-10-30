import { InMemorySpanExporter, initTelemetry } from "@kobe/telemetry";

/** Runs `fn` with tracing on and an in-memory exporter (tests only); tracing is off again after. */
export async function traced<T>(fn: (exporter: InMemorySpanExporter) => Promise<T>): Promise<T> {
  const exporter = new InMemorySpanExporter();
  const telemetry = initTelemetry(
    {
      enabled: true,
      endpoint: "http://x:4318",
      headers: {},
      captureContent: false,
      serviceName: "t",
    },
    { exporter },
  );
  try {
    return await fn(exporter);
  } finally {
    await telemetry.shutdown();
  }
}

type Finished = ReturnType<InMemorySpanExporter["getFinishedSpans"]>[number];

/** The finished span named `name` (the first one), if any. */
export const spanNamed = (exporter: InMemorySpanExporter, name: string): Finished | undefined =>
  exporter.getFinishedSpans().find((s) => s.name === name);

/** Whether `child`'s parent is `parent`. */
export const isChildOf = (child: Finished | undefined, parent: Finished | undefined): boolean =>
  child !== undefined &&
  parent !== undefined &&
  child.parentSpanContext?.spanId === parent.spanContext().spanId &&
  child.spanContext().traceId === parent.spanContext().traceId;
