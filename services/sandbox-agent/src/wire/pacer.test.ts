import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SANDBOX_MAX_FRAME_BYTES, SANDBOX_SEND_PACE } from "@kobe/protocol";
import { SendPacer, type PaceLimits } from "./pacer.js";

const LIMITS: PaceLimits = { framesPerSec: 100, frameBurst: 10, bytesPerSec: 1000, byteBurst: 100 };

describe("SendPacer", () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => vi.useRealTimers());

  function pacer(limits = LIMITS) {
    const out: string[] = [];
    const p = new SendPacer(limits, (text) => out.push(text));
    return { p, out };
  }

  it("sends a burst at once, then holds the rest in order until tokens refill", () => {
    const { p, out } = pacer();
    for (let i = 0; i < 25; i++) p.send(`${i}`);
    expect(out).toHaveLength(10);
    expect(p.queued).toBe(15);
    vi.advanceTimersByTime(50); // 100/s: 5 more frames
    expect(out).toHaveLength(15);
    vi.advanceTimersByTime(100);
    expect(out).toEqual(Array.from({ length: 25 }, (_, i) => `${i}`));
    expect(p.queued).toBe(0);
  });

  it("paces by bytes too, and lets a frame larger than the burst through once the bucket is full", () => {
    const { p, out } = pacer();
    p.send("x".repeat(60));
    p.send("y".repeat(60)); // 40 bytes left: waits 20 ms for 20 more
    expect(out).toHaveLength(1);
    vi.advanceTimersByTime(19);
    expect(out).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(out).toHaveLength(2);
    p.send("z".repeat(150)); // over the burst: waits for a full bucket, never stalls forever
    vi.advanceTimersByTime(100);
    expect(out).toHaveLength(3);
  });

  it("never exceeds the limits over any window (token bucket check)", () => {
    const sentAt: { t: number; bytes: number }[] = [];
    const p = new SendPacer(LIMITS, (text) => sentAt.push({ t: Date.now(), bytes: text.length }));
    for (let i = 0; i < 200; i++) p.send("a".repeat(1 + (i % 9)));
    vi.advanceTimersByTime(10_000);
    expect(sentAt).toHaveLength(200);
    let frames = LIMITS.frameBurst;
    let bytes = LIMITS.byteBurst;
    let at = 0;
    for (const s of sentAt) {
      frames = Math.min(LIMITS.frameBurst, frames + ((s.t - at) / 1000) * LIMITS.framesPerSec);
      bytes = Math.min(LIMITS.byteBurst, bytes + ((s.t - at) / 1000) * LIMITS.bytesPerSec);
      at = s.t;
      expect(frames).toBeGreaterThanOrEqual(1);
      expect(bytes).toBeGreaterThanOrEqual(s.bytes);
      frames -= 1;
      bytes -= s.bytes;
    }
  });

  it("is a no-op under budget: frames go out in the same tick, with no timer", () => {
    const { p, out } = pacer(SANDBOX_SEND_PACE);
    for (let i = 0; i < 200; i++) {
      p.send(`f${i}`);
      expect(out).toHaveLength(i + 1); // written synchronously, before send() returns
    }
    expect(p.queued).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends one largest frame at once on a fresh connection, and a second within a bounded wait", () => {
    const { p, out } = pacer(SANDBOX_SEND_PACE);
    const big = "x".repeat(SANDBOX_MAX_FRAME_BYTES);
    p.send(big);
    expect(out).toHaveLength(1);
    p.send(big); // never deadlocks: waits for a full byte bucket (burst / rate), then goes
    const waitMs = Math.ceil((SANDBOX_MAX_FRAME_BYTES / SANDBOX_SEND_PACE.bytesPerSec) * 1000);
    vi.advanceTimersByTime(waitMs);
    expect(out).toHaveLength(2);
  });

  it("reset drops the queue and refills the buckets (a new connection)", () => {
    const { p, out } = pacer();
    for (let i = 0; i < 20; i++) p.send(`${i}`);
    p.reset();
    expect(p.queued).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(out).toHaveLength(10);
    for (let i = 0; i < 10; i++) p.send(`n${i}`);
    expect(out).toHaveLength(20);
  });
});
