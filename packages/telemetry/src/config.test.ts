import { describe, expect, it } from "vitest";
import { loadTelemetryConfig } from "./config.js";

describe("loadTelemetryConfig", () => {
  it("is disabled without an endpoint", () => {
    const c = loadTelemetryConfig({}, "server");
    expect(c).toMatchObject({ enabled: false, captureContent: false, serviceName: "kobe-server" });
  });

  it("parses endpoint, headers and the capture switch", () => {
    const c = loadTelemetryConfig(
      {
        KOBE_OTEL_ENDPOINT: "http://collector:4318/",
        KOBE_OTEL_HEADERS: "authorization=Bearer abc, x-team=1",
        KOBE_OTEL_CAPTURE_CONTENT: "true",
      },
      "mcp-proxy",
    );
    expect(c.enabled).toBe(true);
    expect(c.endpoint).toBe("http://collector:4318");
    expect(c.headers).toEqual({ authorization: "Bearer abc", "x-team": "1" });
    expect(c.captureContent).toBe(true);
  });

  it("fails fast on a malformed setting without echoing values", () => {
    expect(() => loadTelemetryConfig({ KOBE_OTEL_ENDPOINT: "nope" }, "server")).toThrow(
      /KOBE_OTEL_ENDPOINT/,
    );
    expect(() => loadTelemetryConfig({ KOBE_OTEL_CAPTURE_CONTENT: "sometimes" }, "server")).toThrow(
      /KOBE_OTEL_CAPTURE_CONTENT/,
    );
    expect(() =>
      loadTelemetryConfig(
        { KOBE_OTEL_ENDPOINT: "http://c:4318", KOBE_OTEL_HEADERS: "secretvalue" },
        "server",
      ),
    ).toThrow(/KOBE_OTEL_HEADERS/);
    try {
      loadTelemetryConfig({ KOBE_OTEL_HEADERS: "secretvalue" }, "server");
    } catch (e) {
      expect(String(e)).not.toContain("secretvalue");
    }
  });
});
