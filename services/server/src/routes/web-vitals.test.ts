import { Hono } from "hono";
import { InMemorySpanExporter, initTelemetry, type Telemetry } from "@kobe/telemetry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthVariables } from "../auth/session.js";
import { createRateLimiter } from "../sandbox/rate-limit.js";
import { normalizeRoute, webVitalsRoutes, WEB_VITALS_MAX_BODY } from "./web-vitals.js";

const USER = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

let exporter: InMemorySpanExporter;
let telemetry: Telemetry;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
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
});

afterEach(async () => {
  await telemetry.shutdown();
});

function mount(limit = { capacity: 100, refillPerSecond: 1 }) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use(async (c, next) => {
    c.set("user", { id: USER, email: "a@b.test", name: "A", twoFactorEnabled: false });
    await next();
  });
  app.route("/v1/telemetry", webVitalsRoutes({ limiter: createRateLimiter(limit) }));
  return app;
}

const post = (app: Hono<{ Variables: AuthVariables }>, body: unknown) =>
  app.request("/v1/telemetry/web-vitals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const spans = () => exporter.getFinishedSpans().filter((s) => s.name.startsWith("web.vital"));

describe("POST /v1/telemetry/web-vitals (KOBE-525)", () => {
  it("turns each report into a span whose duration is the metric, named by metric and route", async () => {
    const res = await post(mount(), {
      reports: [
        {
          name: "LCP",
          value: 1234.5,
          route: "/threads",
          rating: "good",
          navigation_type: "navigate",
        },
        { name: "CLS", value: 0.12, route: "/admin/site/users" },
      ],
    });
    expect(res.status).toBe(204);
    const [lcp, cls] = spans();
    expect(lcp?.name).toBe("web.vital LCP /threads");
    expect(lcp?.attributes).toEqual({
      "kobe.web_vital.name": "LCP",
      "kobe.web_vital.value": 1234.5,
      "http.route": "/threads",
      "kobe.web_vital.rating": "good",
      "kobe.web_vital.navigation_type": "navigate",
    });
    const ms = (s: typeof lcp) =>
      s ? (s.endTime[0] - s.startTime[0]) * 1000 + (s.endTime[1] - s.startTime[1]) / 1e6 : NaN;
    expect(Math.abs(ms(lcp) - 1234.5)).toBeLessThanOrEqual(1); // spans keep whole ms
    // CLS is unitless: its span lasts 1000 × the score (milli-CLS), the raw score is an attribute.
    expect(cls?.name).toBe("web.vital CLS /admin/site/users");
    expect(ms(cls)).toBeCloseTo(120, 0);
    expect(cls?.attributes["kobe.web_vital.value"]).toBe(0.12);
  });

  it("refuses unknown metrics, negative or huge values, extra fields and empty batches", async () => {
    const app = mount();
    for (const body of [
      { reports: [{ name: "XSS", value: 1, route: "/" }] },
      { reports: [{ name: "LCP", value: -1, route: "/" }] },
      { reports: [{ name: "LCP", value: 1e9, route: "/" }] },
      { reports: [{ name: "LCP", value: 1, route: "/", user: "x" }] },
      { reports: [] },
      { reports: Array.from({ length: 21 }, () => ({ name: "LCP", value: 1, route: "/" })) },
      "not json",
    ]) {
      expect((await post(app, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(spans()).toEqual([]);
  });

  it("caps the body size", async () => {
    const res = await post(mount(), { reports: [], pad: "x".repeat(WEB_VITALS_MAX_BODY) });
    expect(res.status).toBe(413);
  });

  it("rate-limits per user", async () => {
    const app = mount({ capacity: 1, refillPerSecond: 0.001 });
    const body = { reports: [{ name: "TTFB", value: 10, route: "/" }] };
    expect((await post(app, body)).status).toBe(204);
    const limited = await post(app, body);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
  });
});

describe("normalizeRoute", () => {
  it("keeps route templates and replaces anything id-like, so the attribute stays low-cardinality", () => {
    expect(normalizeRoute("/")).toBe("/");
    expect(normalizeRoute("/admin/site/skill-tags/catalog/[id]/edit")).toBe(
      "/admin/site/skill-tags/catalog/[id]/edit",
    );
    expect(normalizeRoute("/me/agents/0b6f1c2e-6d1a-4c56-9a43-1f0e2d3c4b5a")).toBe(
      "/me/agents/[id]",
    );
    expect(normalizeRoute("/me/agents/12345/cases")).toBe("/me/agents/[id]/cases");
    expect(normalizeRoute("/threads?thread=abc#x")).toBe("/threads");
    expect(normalizeRoute("/A/<script>")).toBe("/[id]/[id]");
    expect(normalizeRoute("relative")).toBe("other");
    expect(normalizeRoute("/a/b/c/d/e/f/g/h/i")).toBe("other");
  });
});
