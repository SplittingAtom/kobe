import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { honoTracing } from "./hono.js";
import { initTelemetry, type Telemetry } from "./init.js";
import { traceNodeRequest } from "./node-http.js";

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

describe("traceNodeRequest", () => {
  it("ends the span with the response and keeps the URL out", async () => {
    const exporter = start(false);
    const server = createServer((req, res) =>
      traceNodeRequest("gateway.request", req, res, () => res.end("ok")),
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages?key=s3cret`, {
      method: "POST",
      body: "prompt text",
      headers: { traceparent: TRACEPARENT },
    });
    await res.text();
    await new Promise<void>((r) => server.close(() => r()));
    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe("gateway.request");
    expect(span?.attributes["http.response.status_code"]).toBe(200);
    expect(span?.attributes["http.request.body.size"]).toBe(11);
    expect(span?.parentSpanContext?.spanId).toBe("b7ad6b7169203331");
    expect(JSON.stringify(span?.attributes)).not.toMatch(/s3cret|prompt text|v1\/messages/);
  });
});
