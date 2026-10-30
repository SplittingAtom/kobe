// @vitest-environment node
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  TIMING_ID_HEADER,
  createServerTiming,
  formatMetric,
  recordServerTiming,
  type TimedRequest,
  type TimedResponse,
} from "./server-timing";

/** KOBE-530 ac-1: the HTML response says where its server time went (Server-Timing). */

class FakeResponse extends EventEmitter implements TimedResponse {
  readonly headers = new Map<string, string>();
  written: unknown[] | undefined;
  getHeader(name: string) {
    return this.headers.get(name.toLowerCase());
  }
  setHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }
  writeHead(...args: unknown[]) {
    this.written = args;
    return this;
  }
}

function harness() {
  let clock = 0;
  let ids = 0;
  let listener: ((message: unknown) => void) | undefined;
  createServerTiming({
    now: () => clock,
    newId: () => `id-${++ids}`,
    subscribe: (_name, fn) => {
      listener = fn;
    },
  });
  const request = (headers: Record<string, string> = {}) => {
    const req: TimedRequest = { headers: { ...headers } };
    const res = new FakeResponse();
    listener?.({ request: req, response: res });
    return { req, res };
  };
  return {
    request,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const html = (res: FakeResponse) => res.setHeader("content-type", "text/html; charset=utf-8");

describe("formatMetric", () => {
  it("writes name;dur with one decimal, and an optional desc", () => {
    expect(formatMetric("branding", 12.345)).toBe("branding;dur=12.3");
    expect(formatMetric("cold", undefined, "first page")).toBe('cold;desc="first page"');
  });
});

describe("Server-Timing on HTML responses", () => {
  it("gives every request a fresh timing id, replacing one the client sent", () => {
    const h = harness();
    const { req } = h.request({ [TIMING_ID_HEADER]: "forged" });
    expect(req.headers[TIMING_ID_HEADER]).toBe("id-1");
  });

  it("carries the render's metrics, the time to the headers and the cold marker once", () => {
    const h = harness();
    const first = h.request();
    h.advance(400);
    recordServerTiming(new Headers({ [TIMING_ID_HEADER]: "id-1" }), "branding", 1000.04);
    h.advance(700);
    html(first.res);
    first.res.writeHead(200);
    expect(first.res.headers.get("server-timing")).toBe(
      'branding;dur=1000.0, app;dur=1100.0;desc="server time to first byte", cold;desc="first page of this web process"',
    );
    expect(first.res.written).toEqual([200]);

    const second = h.request();
    h.advance(15);
    html(second.res);
    second.res.writeHead(200);
    expect(second.res.headers.get("server-timing")).toBe(
      'app;dur=15.0;desc="server time to first byte"',
    );
  });

  it("reads the content type from writeHead's own headers too", () => {
    const h = harness();
    const { res } = h.request();
    res.writeHead(200, { "Content-Type": "text/html" });
    expect(res.headers.get("server-timing")).toContain("app;dur=0.0");
  });

  it("leaves other responses alone and keeps the cold marker for the first page", () => {
    const h = harness();
    const asset = h.request();
    asset.res.setHeader("content-type", "application/json");
    asset.res.writeHead(200);
    expect(asset.res.headers.has("server-timing")).toBe(false);
    const page = h.request();
    html(page.res);
    page.res.writeHead(200);
    expect(page.res.headers.get("server-timing")).toContain("cold;");
  });

  it("forgets a request once answered or closed: later records are ignored", () => {
    const h = harness();
    const done = h.request();
    html(done.res);
    done.res.writeHead(200);
    recordServerTiming(new Headers({ [TIMING_ID_HEADER]: "id-1" }), "late", 5);
    const closed = h.request();
    closed.res.emit("close");
    recordServerTiming(new Headers({ [TIMING_ID_HEADER]: "id-2" }), "late", 5);
    html(closed.res);
    closed.res.writeHead(200);
    expect(closed.res.headers.has("server-timing")).toBe(false);
  });

  it("ignores records without a known timing id", () => {
    expect(() => recordServerTiming(new Headers(), "branding", 1)).not.toThrow();
    expect(() =>
      recordServerTiming(new Headers({ [TIMING_ID_HEADER]: "nope" }), "branding", 1),
    ).not.toThrow();
  });
});
