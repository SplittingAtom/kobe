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
import { setTelemetryState } from "./state.js";

export interface Telemetry {
  readonly enabled: boolean;
  readonly captureContent: boolean;
  shutdown(): Promise<void>;
}

export interface InitOptions {
  /** Tests: export here (synchronously) instead of OTLP. */
  readonly exporter?: SpanExporter;
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
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": config.serviceName }),
    spanProcessors: [
      options.exporter ? new SimpleSpanProcessor(exporter) : new BatchSpanProcessor(exporter),
    ],
  });
  const contextManager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(contextManager);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
  setTelemetryState({ enabled: true, captureContent: config.captureContent });
  return {
    enabled: true,
    captureContent: config.captureContent,
    async shutdown() {
      await provider.shutdown();
      trace.disable();
      propagation.disable();
      context.disable();
      setTelemetryState({ enabled: false, captureContent: false });
    },
  };
}
