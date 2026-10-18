import { context, propagation, trace } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { TelemetryConfig } from "./config.js";
import { ContentGuardExporter } from "./content.js";
import { RELAY_QUEUE_DEFAULTS, SpanRelay, type RelayQueueOptions } from "./relay.js";
import { RunIdGenerator, setRunIdGenerator } from "./run-trace.js";
import { setTelemetryState } from "./state.js";

export interface Telemetry {
  readonly enabled: boolean;
  readonly captureContent: boolean;
  shutdown(): Promise<void>;
}

export interface InitOptions {
  /** Tests: export here (synchronously) instead of OTLP. */
  readonly exporter?: SpanExporter;
  /** Tests: export relayed spans here (default: `exporter`). */
  readonly relayExporter?: SpanExporter;
  /** The relayed-span queue (KOBE-274); defaults suit a server replica. */
  readonly relayQueue?: RelayQueueOptions;
}

/** `service.name` of spans the server relays for sandbox agents (KOBE-274). */
export const RELAY_SERVICE_NAME = "kobe-sandbox-agent";

let relay: SpanRelay | undefined;

/** The relayed-span queue, when tracing is on (KOBE-274). */
export function spanRelay(): SpanRelay | undefined {
  return relay;
}

const OFF: Telemetry = {
  enabled: false,
  captureContent: false,
  shutdown: () => Promise.resolve(),
};

/**
 * Starts tracing when an endpoint is configured; otherwise registers nothing, so the API's no-op
 * tracer stays in place. Only W3C trace context is propagated (no baggage).
 */
export function initTelemetry(config: TelemetryConfig, options: InitOptions = {}): Telemetry {
  if (!config.enabled && !options.exporter) return OFF;
  const inner =
    options.exporter ??
    new OTLPTraceExporter({
      url: `${config.endpoint}/v1/traces`,
      headers: { ...config.headers },
    });
  const exporter = new ContentGuardExporter(inner, config.captureContent);
  const idGenerator = new RunIdGenerator();
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": config.serviceName }),
    idGenerator,
    spanProcessors: [
      options.exporter ? new SimpleSpanProcessor(exporter) : new BatchSpanProcessor(exporter),
    ],
  });
  // Relayed spans: their own exporter instance and bounded queue, behind the same content gate.
  const relayInner =
    options.relayExporter ??
    options.exporter ??
    new OTLPTraceExporter({
      url: `${config.endpoint}/v1/traces`,
      headers: { ...config.headers },
    });
  relay = new SpanRelay(
    new ContentGuardExporter(relayInner, config.captureContent),
    resourceFromAttributes({ "service.name": RELAY_SERVICE_NAME }),
    options.relayQueue ?? RELAY_QUEUE_DEFAULTS,
  );
  setRunIdGenerator(idGenerator);
  const contextManager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(contextManager);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
  setTelemetryState({ enabled: true, captureContent: config.captureContent });
  return {
    enabled: true,
    captureContent: config.captureContent,
    async shutdown() {
      const closing = relay;
      relay = undefined;
      setRunIdGenerator(undefined);
      await closing?.shutdown();
      await provider.shutdown();
      trace.disable();
      propagation.disable();
      context.disable();
      setTelemetryState({ enabled: false, captureContent: false });
    },
  };
}
