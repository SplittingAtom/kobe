import { describe, expect, it } from "vitest";
import { createLimiter } from "./limits.js";

describe("createLimiter", () => {
  it("refills request tokens over time, per sandbox", () => {
    let t = 0;
    const limiter = createLimiter({
      burst: 2,
      perSecond: 1,
      callsPerSandbox: 1,
      maxConcurrentCalls: 10,
      now: () => t,
    });
    expect([limiter.takeRequest("a"), limiter.takeRequest("a"), limiter.takeRequest("a")]).toEqual([
      true,
      true,
      false,
    ]);
    expect(limiter.takeRequest("b")).toBe(true);
    t = 1_000;
    expect(limiter.takeRequest("a")).toBe(true);
    expect(limiter.takeRequest("a")).toBe(false);
  });

  it("caps concurrent calls per sandbox and in total; release is idempotent", () => {
    const limiter = createLimiter({
      burst: 1,
      perSecond: 1,
      callsPerSandbox: 2,
      maxConcurrentCalls: 3,
    });
    const a1 = limiter.acquireCall("a");
    const a2 = limiter.acquireCall("a");
    expect(limiter.acquireCall("a")).toBeUndefined();
    const b1 = limiter.acquireCall("b");
    expect(limiter.acquireCall("c")).toBeUndefined();
    expect(limiter.activeCalls).toBe(3);
    a1?.();
    a1?.();
    expect(limiter.activeCalls).toBe(2);
    expect(limiter.acquireCall("a")).toBeDefined();
    a2?.();
    b1?.();
  });

  it("bounds the number of tracked sandboxes", () => {
    const limiter = createLimiter({
      burst: 1,
      perSecond: 0.001,
      callsPerSandbox: 1,
      maxConcurrentCalls: 1,
      maxSandboxes: 2,
    });
    for (const id of ["a", "b", "c", "d"]) expect(limiter.takeRequest(id)).toBe(true);
  });
});
