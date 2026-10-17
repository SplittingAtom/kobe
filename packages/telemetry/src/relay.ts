import { SpanKind, SpanStatusCode, TraceFlags, type Attributes } from "@opentelemetry/api";
import { ExportResultCode, hrTimeDuration, millisToHrTime } from "@opentelemetry/core";
import type { Resource } from "@opentelemetry/resources";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

/**
 * Spans recorded elsewhere (the sandbox agent, KOBE-274) that the server exports for them. They
 * get their **own** bounded queue and exporter, separate from the process's own spans, so a flood
 * of relayed spans can never evict or delay the server's spans: over the queue's size new spans
 * are dropped and counted. Ids, times and attributes arrive validated and re-attributed by the
 * caller; the exporter behind this queue is wrapped in the content gate like the main one.
 */
export interface RelaySpan {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly error: boolean;
  readonly attributes: Attributes;
}

export interface RelayQueueOptions {
  /** Spans held at most (queued plus in the batch being exported). */
  readonly maxQueue: number;
  readonly batchSize: number;
  readonly intervalMs: number;
}

export const RELAY_QUEUE_DEFAULTS: RelayQueueOptions = {
  maxQueue: 4096,
  batchSize: 512,
  intervalMs: 1000,
};

const SCOPE = { name: "kobe.sandbox-relay" };

function readable(span: RelaySpan, resource: Resource): ReadableSpan {
  const startTime = millisToHrTime(span.startMs);
  const endTime = millisToHrTime(span.endMs);
  const spanContext = {
    traceId: span.traceId,
    spanId: span.spanId,
    traceFlags: TraceFlags.SAMPLED,
  };
  return {
    name: span.name,
    kind: SpanKind.INTERNAL,
    spanContext: () => spanContext,
    parentSpanContext: {
      traceId: span.traceId,
      spanId: span.parentSpanId,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    },
    startTime,
    endTime,
    duration: hrTimeDuration(startTime, endTime),
    status: { code: span.error ? SpanStatusCode.ERROR : SpanStatusCode.UNSET },
    attributes: span.attributes,
    links: [],
    events: [],
    ended: true,
    resource,
    instrumentationScope: SCOPE,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}

export class SpanRelay {
  readonly #exporter: SpanExporter;
  readonly #resource: Resource;
  readonly #options: RelayQueueOptions;
  #queue: ReadableSpan[] = [];
  #inFlight = 0;
  #exporting: Promise<void> | undefined;
  #dropped = 0;
  #exportFailures = 0;
  readonly #timer: NodeJS.Timeout;

  constructor(exporter: SpanExporter, resource: Resource, options: RelayQueueOptions) {
    this.#exporter = exporter;
    this.#resource = resource;
    this.#options = options;
    this.#timer = setInterval(() => void this.#exportBatch(), options.intervalMs);
    this.#timer.unref();
  }

  /** Spans dropped because the queue was full (since start). */
  get dropped(): number {
    return this.#dropped;
  }

  /** Batches the exporter failed to deliver (since start). */
  get exportFailures(): number {
    return this.#exportFailures;
  }

  get queued(): number {
    return this.#queue.length + this.#inFlight;
  }

  /** Queues what fits; returns how many were accepted (the rest are dropped and counted). */
  offer(spans: readonly RelaySpan[]): number {
    const room = Math.max(0, this.#options.maxQueue - this.queued);
    const accepted = spans.slice(0, room).map((s) => readable(s, this.#resource));
    this.#dropped += spans.length - accepted.length;
    this.#queue = [...this.#queue, ...accepted];
    if (this.#queue.length >= this.#options.batchSize) void this.#exportBatch();
    return accepted.length;
  }

  /** Exports everything queued now (tests, shutdown). */
  async flush(): Promise<void> {
    while (this.#exporting || this.#queue.length > 0) {
      await (this.#exporting ?? this.#exportBatch());
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.#timer);
    await this.flush();
    await this.#exporter.shutdown();
  }

  #exportBatch(): Promise<void> {
    if (this.#exporting || this.#queue.length === 0) return this.#exporting ?? Promise.resolve();
    const batch = this.#queue.slice(0, this.#options.batchSize);
    this.#queue = this.#queue.slice(batch.length);
    this.#inFlight = batch.length;
    this.#exporting = new Promise<void>((resolve) => {
      try {
        this.#exporter.export(batch, (result) => {
          if (result.code !== ExportResultCode.SUCCESS) this.#exportFailures += 1;
          resolve();
        });
      } catch {
        this.#exportFailures += 1;
        resolve();
      }
    }).finally(() => {
      this.#inFlight = 0;
      this.#exporting = undefined;
    });
    return this.#exporting;
  }
}
