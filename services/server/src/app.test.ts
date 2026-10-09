import { InMemorySpanExporter, initTelemetry } from "@kobe/telemetry";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

describe("server health endpoints", () => {
  const app = createApp();

  it("GET /healthz reports the service as alive", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "server" });
  });

  it("GET /readyz reports the service as ready", async () => {
    const res = await app.request("/readyz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready", service: "server" });
  });

  it("returns 404 for unknown routes", async () => {
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
  });
});

describe("server tracing (KOBE-10)", () => {
  it("emits a metadata-only span in the caller's trace", async () => {
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
      await createApp().request("/healthz?token=s3cret", {
        headers: { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" },
      });
      const [span] = exporter.getFinishedSpans();
      expect(span?.spanContext().traceId).toBe("0af7651916cd43dd8448eb211c80319c");
      expect(span?.attributes["http.response.status_code"]).toBe(200);
      expect(JSON.stringify(span?.attributes)).not.toContain("s3cret");
    } finally {
      await telemetry.shutdown();
    }
  });
});
