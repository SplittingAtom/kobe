import { describe, expect, it, vi } from "vitest";
import {
  VITALS_FLUSH_AT,
  createVitalsQueue,
  isReportedRoute,
  routeTemplate,
  toReport,
} from "./web-vitals";

/** KOBE-525 ac-1: what the browser sends about each page's Web Vitals, and when. */
describe("routeTemplate", () => {
  it("folds ids so the server gets route templates", () => {
    expect(routeTemplate("/")).toBe("/");
    expect(routeTemplate("/admin/site/users")).toBe("/admin/site/users");
    expect(routeTemplate("/me/agents/0b6f1c2e-6d1a-4c56-9a43-1f0e2d3c4b5a/cases")).toBe(
      "/me/agents/[id]/cases",
    );
    expect(routeTemplate("/admin/team/agents/42")).toBe("/admin/team/agents/[id]");
    expect(routeTemplate("/me/skills/catalog/My_Skill")).toBe("/me/skills/catalog/[id]");
  });
});

describe("isReportedRoute", () => {
  it("skips the signed-out pages (the endpoint needs a session)", () => {
    for (const path of ["/sign-in", "/forgot-password", "/reset-password", "/invite", "/setup"]) {
      expect(isReportedRoute(path), path).toBe(false);
    }
    expect(isReportedRoute("/")).toBe(true);
    expect(isReportedRoute("/admin/site/users")).toBe(true);
  });
});

describe("toReport", () => {
  it("keeps known metrics with finite non-negative values only", () => {
    expect(
      toReport({ name: "LCP", value: 812.4, rating: "good", navigationType: "navigate" }, "/x/1"),
    ).toEqual({
      name: "LCP",
      value: 812.4,
      route: "/x/[id]",
      rating: "good",
      navigation_type: "navigate",
    });
    expect(toReport({ name: "TTFB", value: 3, navigationType: "weird" }, "/")).toEqual({
      name: "TTFB",
      value: 3,
      route: "/",
    });
    expect(toReport({ name: "Custom", value: 1 }, "/")).toBeUndefined();
    expect(toReport({ name: "LCP", value: Number.NaN }, "/")).toBeUndefined();
    expect(toReport({ name: "LCP", value: -1 }, "/")).toBeUndefined();
  });
});

describe("createVitalsQueue", () => {
  const report = { name: "FCP" as const, value: 100, route: "/" };

  it("sends a full batch at once and the rest on flush; never an empty batch", () => {
    const send = vi.fn();
    const queue = createVitalsQueue(send);
    for (let i = 0; i < VITALS_FLUSH_AT + 1; i++) queue.add(report);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toHaveLength(VITALS_FLUSH_AT);
    queue.flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toEqual([report]);
    queue.flush();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("never throws while sending fails (a full batch is dropped, memory stays bounded)", () => {
    const send = vi.fn(() => {
      throw new Error("offline");
    });
    const queue = createVitalsQueue(send);
    for (let i = 0; i < 100; i++) queue.add(report);
    expect(() => queue.flush()).not.toThrow();
  });
});
