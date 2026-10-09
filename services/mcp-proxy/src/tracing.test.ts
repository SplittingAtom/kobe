import { InMemorySpanExporter, initTelemetry, withSpan } from "@kobe/telemetry";
import { describe, expect, it } from "vitest";
import { createPolicyServer } from "./server-client.js";

describe("trace propagation to the server (KOBE-10)", () => {
  it("sends traceparent on the policy re-check, and nothing when tracing is off", async () => {
    const seen: Headers[] = [];
    const server = createPolicyServer({
      baseUrl: "http://server:8082",
      internalKey: "k".repeat(40),
      timeoutMs: 1_000,
      fetch: (async (_url: unknown, init?: RequestInit) => {
        seen.push(new Headers(init?.headers));
        return new Response("{}", { status: 404 });
      }) as typeof fetch,
    });
    await server.listTools("tok", "c1");
    expect(seen[0]?.get("traceparent")).toBeNull();

    const telemetry = initTelemetry(
      {
        enabled: true,
        endpoint: "http://x:4318",
        headers: {},
        captureContent: false,
        serviceName: "t",
      },
      { exporter: new InMemorySpanExporter() },
    );
    try {
      await withSpan("mcp.tools/call", {}, () => server.listTools("tok", "c1"));
      expect(seen[1]?.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    } finally {
      await telemetry.shutdown();
    }
  });
});
