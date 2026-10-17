import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { initTelemetry, spanRelay, type Telemetry } from "./init.js";
import { recordRunRootSpan, runParentContext, sessionAttributes } from "./run-trace.js";
import { withSpan } from "./spans.js";
import type { RelaySpan } from "./relay.js";

const RUN = "3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6071";
const TRACE = "3e4f5a6b7c8d4e9f8a1b2c3d4e5f6071";
const ROOT = "8a1b2c3d4e5f6071";

let telemetry: Telemetry | undefined;
afterEach(async () => {
  await telemetry?.shutdown();
  telemetry = undefined;
});

function start(captureContent = false, relayExporter?: InMemorySpanExporter, maxQueue = 4096) {
  const exporter = new InMemorySpanExporter();
  telemetry = initTelemetry(
    { enabled: true, endpoint: "http://x:4318", headers: {}, captureContent, serviceName: "t" },
    {
      exporter,
      ...(relayExporter ? { relayExporter } : {}),
      relayQueue: { maxQueue, batchSize: 512, intervalMs: 60_000 },
    },
  );
  return exporter;
}

const relaySpan = (i: number, attributes: RelaySpan["attributes"] = {}): RelaySpan => ({
  name: "sandbox.tool",
  traceId: TRACE,
  spanId: (i + 1).toString(16).padStart(16, "0"),
  parentSpanId: ROOT,
  startMs: 1_792_000_000_000,
  endMs: 1_792_000_000_010.5,
  error: i % 2 === 1,
  attributes,
});

describe("run traces", () => {
  it("records the run root with the run's fixed ids, and children join it", async () => {
    const exporter = start();
    await withSpan("sandbox.command", { parent: runParentContext(RUN) }, () => undefined);
    recordRunRootSpan({
      runId: RUN,
      startMs: 1_792_000_000_000,
      endMs: 1_792_000_005_000,
      attributes: sessionAttributes({ threadId: "t1", userId: "u1" }),
    });
    const [command, root] = exporter.getFinishedSpans();
    expect(command?.spanContext().traceId).toBe(TRACE);
    expect(command?.parentSpanContext?.spanId).toBe(ROOT);
    expect(root?.name).toBe("kobe.run");
    expect(root?.spanContext()).toMatchObject({ traceId: TRACE, spanId: ROOT });
    expect(root?.parentSpanContext).toBeUndefined();
    expect(root?.attributes).toEqual({ "session.id": "t1", "user.id": "u1" });
    // Other spans keep random ids.
    await withSpan("other", {}, () => undefined);
    expect(exporter.getFinishedSpans()[2]?.spanContext().traceId).not.toBe(TRACE);
  });

  it("does nothing with tracing off", () => {
    recordRunRootSpan({ runId: RUN, startMs: 1, endMs: 2, attributes: {} });
    expect(spanRelay()).toBeUndefined();
  });
});

describe("span relay", () => {
  it("exports relayed spans through its own queue, behind the content gate", async () => {
    const relayed = new InMemorySpanExporter();
    const own = start(false, relayed);
    const relay = spanRelay();
    expect(
      relay?.offer([relaySpan(0, { "kobe.tool.input": "secret", "kobe.tool.outcome": "ok" })]),
    ).toBe(1);
    await relay?.flush();
    const [span] = relayed.getFinishedSpans();
    expect(span?.spanContext()).toMatchObject({ traceId: TRACE, spanId: "0000000000000001" });
    expect(span?.parentSpanContext?.spanId).toBe(ROOT);
    expect(span?.attributes).toEqual({ "kobe.tool.outcome": "ok" });
    expect(span?.resource.attributes["service.name"]).toBe("kobe-sandbox-agent");
    expect(own.getFinishedSpans()).toHaveLength(0);
  });

  it("keeps content with capture on", async () => {
    const relayed = new InMemorySpanExporter();
    start(true, relayed);
    spanRelay()?.offer([relaySpan(0, { "kobe.tool.input": "q" })]);
    await spanRelay()?.flush();
    expect(relayed.getFinishedSpans()[0]?.attributes["kobe.tool.input"]).toBe("q");
  });

  it("drops and counts what does not fit, never touching the server's own spans", async () => {
    const relayed = new InMemorySpanExporter();
    const own = start(false, relayed, 3);
    const relay = spanRelay();
    expect(relay?.offer([0, 1, 2, 3, 4].map((i) => relaySpan(i)))).toBe(3);
    expect(relay?.dropped).toBe(2);
    await withSpan("server.span", {}, () => undefined);
    expect(own.getFinishedSpans().map((s) => s.name)).toEqual(["server.span"]);
    await relay?.flush();
    expect(relayed.getFinishedSpans()).toHaveLength(3);
    expect(relay?.offer([relaySpan(5)])).toBe(1);
  });
});
