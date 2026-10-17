import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { honoTracing } from "./hono.js";
import { initTelemetry, type Telemetry } from "./init.js";
import { traceNodeRequest } from "./node-http.js";
import { runParentContext } from "./run-trace.js";

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

const TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

describe("honoTracing", () => {
  const app = new Hono();
  app.use("*", honoTracing());
  app.get("/v1/threads/:id", (c) => c.text("secret body"));
  app.get("/boom", () => {
    throw new Error("x");
  });

  it("records route template, status and the caller's trace; no path, query or body", async () => {
    const exporter = start(false);
    const res = await app.request("/v1/threads/abc?token=s3cret", {
      headers: { traceparent: TRACEPARENT },
    });
    expect(res.status).toBe(200);
    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe("GET /v1/threads/:id");
    expect(span?.spanContext().traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(span?.parentSpanContext?.spanId).toBe("b7ad6b7169203331");
    expect(span?.attributes).toMatchObject({
      "http.request.method": "GET",
      "http.route": "/v1/threads/:id",
      "http.response.status_code": 200,
    });
    const dump = JSON.stringify(span?.attributes);
    expect(dump).not.toContain("s3cret");
    expect(dump).not.toContain("abc");
    expect(dump).not.toContain("secret body");
  });

  it("adds the query only with capture on", async () => {
    const exporter = start(true);
    await app.request("/v1/threads/abc?q=1");
    expect(exporter.getFinishedSpans()[0]?.attributes["url.query"]).toBe("q=1");
  });

  it("marks server errors", async () => {
    const exporter = start(false);
    await app.request("/boom");
    expect(exporter.getFinishedSpans()[0]?.status.code).toBe(2);
  });
});

describe("honoTracing for sandbox-reachable listeners", () => {
  const app = new Hono();
  app.use("*", honoTracing({ joinCallerTrace: false }));
  app.get("/x", (c) => c.text("ok"));

  it("never joins the caller's trace (KOBE-274)", async () => {
    const exporter = start(false);
    await app.request("/x", { headers: { traceparent: TRACEPARENT } });
    const [span] = exporter.getFinishedSpans();
    expect(span?.spanContext().traceId).not.toBe("0af7651916cd43dd8448eb211c80319c");
    expect(span?.parentSpanContext).toBeUndefined();
  });
});

async function serve(
  handler: Parameters<typeof createServer>[1],
  init: RequestInit & { path?: string } = {},
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const res = await fetch(
    `http://127.0.0.1:${port}${init.path ?? "/v1/messages?key=s3cret"}`,
    init,
  );
  await res.text();
  await new Promise<void>((r) => server.close(() => r()));
}

describe("traceNodeRequest", () => {
  it("ends the span with the response, keeps the URL out and ignores the caller's trace", async () => {
    const exporter = start(false);
    await serve((req, res) => traceNodeRequest("gateway.request", req, res, () => res.end("ok")), {
      method: "POST",
      body: "prompt text",
      headers: { traceparent: TRACEPARENT },
    });
    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe("gateway.request");
    expect(span?.attributes["http.response.status_code"]).toBe(200);
    expect(span?.attributes["http.request.body.size"]).toBe(11);
    expect(span?.spanContext().traceId).not.toBe("0af7651916cd43dd8448eb211c80319c");
    expect(span?.parentSpanContext).toBeUndefined();
    expect(JSON.stringify(span?.attributes)).not.toMatch(/s3cret|prompt text|v1\/messages/);
  });

  it("opens the span under the parent the handler chose, with attributes set before", async () => {
    const exporter = start(false);
    const parent = runParentContext("3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6071");
    await serve((req, res) =>
      traceNodeRequest("gateway.request", req, res, async (span) => {
        span.setAttributes({ "kobe.call_id": "c1" });
        await new Promise((r) => setTimeout(r, 5));
        span.open(parent);
        span.open(); // the first call wins
        span.setAttributes({ "kobe.route": "openai" });
        res.end("ok");
      }),
    );
    const [span] = exporter.getFinishedSpans();
    expect(span?.spanContext().traceId).toBe("3e4f5a6b7c8d4e9f8a1b2c3d4e5f6071");
    expect(span?.parentSpanContext?.spanId).toBe("8a1b2c3d4e5f6071");
    expect(span?.attributes).toMatchObject({ "kobe.call_id": "c1", "kobe.route": "openai" });
  });
});
