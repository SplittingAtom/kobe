import { describe, expect, it } from "vitest";
import { DEFAULT_BACKOFF, backoffDelay } from "./backoff.js";

describe("backoffDelay", () => {
  it("grows exponentially up to the cap (full jitter at the top of the range)", () => {
    const top = () => 0.999999;
    expect(backoffDelay(0, DEFAULT_BACKOFF, top)).toBe(499);
    expect(backoffDelay(3, DEFAULT_BACKOFF, top)).toBe(3999);
    expect(backoffDelay(50, DEFAULT_BACKOFF, top)).toBe(29_999);
  });

  it("never goes below the floor (no tight reconnect loop)", () => {
    expect(backoffDelay(10, DEFAULT_BACKOFF, () => 0)).toBe(250);
  });

  it("spreads reconnects across the window (no lockstep storm)", () => {
    const delays = new Set(Array.from({ length: 50 }, () => backoffDelay(6)));
    expect(delays.size).toBeGreaterThan(40);
  });
});
