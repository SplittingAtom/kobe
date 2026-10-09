import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { initTelemetry, type Telemetry } from "./init.js";
import { extractContext, injectTraceHeaders } from "./propagation.js";
import { withSpan } from "./spans.js";

let telemetry: Telemetry | undefined;
afterEach(async () => {
  await telemetry?.shutdown();
  telemetry = undefined;
});

describe("propagation", () => {
  it("carries the trace across a hop", async () => {
    const exporter = new InMemorySpanExporter();
    telemetry = initTelemetry(
      {
        enabled: true,
        endpoint: "http://x:4318",
        headers: {},
        captureContent: false,
        serviceName: "t",
      },
      { exporter },
    );
    let headers: Record<string, string> = {};
    await withSpan("client", {}, () => {
      headers = injectTraceHeaders({ accept: "x" });
    });
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    expect(headers.accept).toBe("x");
    const parent = extractContext({ traceparent: headers.traceparent });
    await withSpan("server", { parent }, () => undefined);
    const [client, server] = exporter.getFinishedSpans();
    expect(server?.spanContext().traceId).toBe(client?.spanContext().traceId);
    expect(server?.parentSpanContext?.spanId).toBe(client?.spanContext().spanId);
  });

  it("adds nothing when tracing is off, and does not mutate its input", () => {
    const input = { a: "b" };
    expect(injectTraceHeaders(input)).toEqual({ a: "b" });
    expect(injectTraceHeaders(input)).not.toBe(input);
  });
});
