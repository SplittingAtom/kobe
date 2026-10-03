import { describe, expect, it } from "vitest";
import { BandwidthLimiter, ConnectionLimits } from "./limits.js";

describe("ConnectionLimits", () => {
  it("caps concurrent tunnels per sandbox and releases exactly once", () => {
    const limits = new ConnectionLimits({ perSandbox: 2, total: 10 });
    const a = limits.tryAcquire("s1");
    const b = limits.tryAcquire("s1");
    expect(a && b).toBeTruthy();
    expect(limits.tryAcquire("s1")).toBeNull();
    expect(limits.tryAcquire("s2")).not.toBeNull();
    a?.();
    a?.();
    expect(limits.active("s1")).toBe(1);
    expect(limits.tryAcquire("s1")).not.toBeNull();
  });

  it("caps the total across sandboxes", () => {
    const limits = new ConnectionLimits({ perSandbox: 5, total: 2 });
    expect(limits.tryAcquire("a")).not.toBeNull();
    expect(limits.tryAcquire("b")).not.toBeNull();
    expect(limits.tryAcquire("c")).toBeNull();
    expect(limits.active()).toBe(2);
  });
});

describe("BandwidthLimiter", () => {
  it("lets a burst of one second through, then asks to wait in proportion to the excess", () => {
    let t = 0;
    const bw = new BandwidthLimiter(1000, () => t);
    const detach = bw.attach("s");
    expect(bw.take("s", 1000)).toBe(0);
    expect(bw.take("s", 500)).toBe(500);
    t = 500; // refilled 500: back to zero
    expect(bw.take("s", 0)).toBe(0);
    detach();
    expect(bw.take("s", 10_000)).toBe(0); // no bucket once every tunnel is gone
  });

  it("shares one bucket between a sandbox's tunnels, not across sandboxes", () => {
    const t = 0;
    const bw = new BandwidthLimiter(1000, () => t);
    bw.attach("s");
    bw.attach("s");
    bw.attach("other");
    expect(bw.take("s", 800)).toBe(0);
    expect(bw.take("s", 400)).toBe(200);
    expect(bw.take("other", 800)).toBe(0);
  });

  it("rate 0 disables the limit", () => {
    const bw = new BandwidthLimiter(0);
    bw.attach("s");
    expect(bw.take("s", 1e9)).toBe(0);
  });
});
