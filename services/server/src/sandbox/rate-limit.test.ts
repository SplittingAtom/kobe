import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rate-limit.js";

describe("per-source rate limiter", () => {
  it("allows a burst, then refills at the configured rate", () => {
    let t = 0;
    const limiter = createRateLimiter({ capacity: 3, refillPerSecond: 1, now: () => t });
    expect([1, 2, 3].map(() => limiter.take("a"))).toEqual([0, 0, 0]);
    expect(limiter.take("a")).toBe(1000);
    t += 1000;
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBeGreaterThan(0);
  });

  it("keeps sources apart", () => {
    const limiter = createRateLimiter({ capacity: 1, refillPerSecond: 1, now: () => 0 });
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBeGreaterThan(0);
    expect(limiter.take("b")).toBe(0);
  });

  it("bounds the number of tracked sources", () => {
    let t = 0;
    const limiter = createRateLimiter({
      capacity: 1,
      refillPerSecond: 1,
      maxSources: 2,
      now: () => t,
    });
    limiter.take("a");
    limiter.take("b");
    t += 10;
    limiter.take("c"); // evicts the oldest ("a")
    expect(limiter.take("a")).toBe(0);
  });
});
