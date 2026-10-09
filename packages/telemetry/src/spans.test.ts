import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { initTelemetry, type Telemetry } from "./init.js";
import { annotate, contentAttributes, withSpan } from "./spans.js";

const SECRET_PROMPT = "tell me the launch codes";
let telemetry: Telemetry | undefined;
afterEach(async () => {
  await telemetry?.shutdown();
  telemetry = undefined;
});

function start(captureContent: boolean) {
  const exporter = new InMemorySpanExporter();
  telemetry = initTelemetry(
    { enabled: true, endpoint: "http://x:4318", headers: {}, captureContent, serviceName: "t" },
    { exporter },
  );
  return exporter;
}

/** What a careless call site might record. */
async function runCarelessly() {
  await withSpan(
    "kobe.run",
    {
      attributes: {
        "gen_ai.prompt": SECRET_PROMPT,
        "gen_ai.completion": "answer",
        "kobe.tool.input": '{"q":"x"}',
        "kobe.tool.output": "rows",
        "http.request.header.authorization": "Bearer s3cret",
        "url.query": "token=abc",
        "gen_ai.usage.input_tokens": 12,
        "kobe.run_id": "run-1",
      },
    },
    async (span) => {
      span.setAttributes(contentAttributes({ "gen_ai.prompt": SECRET_PROMPT }));
      annotate({ teamId: "team-1", threadId: "thr-1" });
    },
  );
}

describe("content gating", () => {
  it("exports metadata only by default, whatever the call site records", async () => {
    const exporter = start(false);
    await runCarelessly();
    const [span] = exporter.getFinishedSpans();
    expect(span?.attributes).toEqual({
      "gen_ai.usage.input_tokens": 12,
      "kobe.run_id": "run-1",
      "kobe.team_id": "team-1",
      "kobe.thread_id": "thr-1",
    });
    expect(JSON.stringify(exporter.getFinishedSpans().map((s) => s.attributes))).not.toContain(
      SECRET_PROMPT,
    );
  });

  it("includes content once capture is opted in", async () => {
    const exporter = start(true);
    await runCarelessly();
    const [span] = exporter.getFinishedSpans();
    expect(span?.attributes["gen_ai.prompt"]).toBe(SECRET_PROMPT);
    expect(span?.attributes["kobe.tool.input"]).toBe('{"q":"x"}');
    expect(span?.attributes["url.query"]).toBe("token=abc");
  });

  it("truncates captured values", async () => {
    const exporter = start(true);
    await withSpan(
      "x",
      { attributes: contentAttributes({ "gen_ai.prompt": "a".repeat(100_000) }) },
      () => 1,
    );
    expect(String(exporter.getFinishedSpans()[0]?.attributes["gen_ai.prompt"]).length).toBeLessThan(
      10_000,
    );
  });

  it("records only the error type, never its message", async () => {
    const exporter = start(false);
    await expect(
      withSpan("x", {}, () => {
        throw new TypeError(SECRET_PROMPT);
      }),
    ).rejects.toThrow();
    const span = exporter.getFinishedSpans()[0];
    expect(span?.status.code).toBe(2);
    expect(span?.status.message).toBeUndefined();
    expect(span?.events).toHaveLength(0);
    expect(span?.attributes["error.type"]).toBe("TypeError");
  });

  it("nests child spans under the active span", async () => {
    const exporter = start(false);
    await withSpan("parent", {}, () => withSpan("child", {}, () => undefined));
    const [child, parent] = exporter.getFinishedSpans();
    expect(child?.parentSpanContext?.spanId).toBe(parent?.spanContext().spanId);
  });
});

describe("disabled", () => {
  it("runs the function and registers nothing", async () => {
    telemetry = initTelemetry({
      enabled: false,
      headers: {},
      captureContent: false,
      serviceName: "t",
    });
    expect(telemetry.enabled).toBe(false);
    await expect(withSpan("x", {}, () => 7)).resolves.toBe(7);
  });
});

describe("recordSpan", () => {
  it("records a finished span with its own timing", async () => {
    const { recordSpan } = await import("./spans.js");
    const exporter = start(false);
    recordSpan("egress.connection", {
      startTime: 1_000,
      endTime: 1_250,
      attributes: { "kobe.outcome": "allowed" },
    });
    const span = exporter.getFinishedSpans()[0];
    expect(span?.name).toBe("egress.connection");
    expect(span?.duration).toEqual([0, 250_000_000]);
  });
});
