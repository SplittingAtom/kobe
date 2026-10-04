import { describe, expect, it } from "vitest";
import { ModelTokenKeeper, type TokenGrant } from "./token-keeper.js";

const MARGIN = 120_000;

function harness(grants: (TokenGrant | Error)[]) {
  let now = 1_000_000;
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  let nextId = 1;
  const trades: number[] = [];
  const keeper = new ModelTokenKeeper({
    grant: async () => {
      trades.push(now);
      const next = grants.shift();
      if (next === undefined) throw new Error("no grant scripted");
      if (next instanceof Error) throw next;
      return next;
    },
    refreshMarginMs: MARGIN,
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ fn, ms, id });
      return { unref: () => undefined, id } as { unref: () => void };
    },
    clearTimer: (timer) => {
      const id = (timer as { id: number }).id;
      const at = timers.findIndex((t) => t.id === id);
      if (at >= 0) timers.splice(at, 1);
    },
    logger: { warn: () => undefined },
  });
  const fire = async () => {
    const timer = timers.shift();
    if (!timer) throw new Error("no timer");
    now += timer.ms;
    timer.fn();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { keeper, timers, trades, fire, now: () => now };
}

describe("ModelTokenKeeper", () => {
  it("trades at start and again just inside the refresh margin, telling listeners", async () => {
    const h = harness([
      { token: "t1".padEnd(30, "x"), expiresAt: 1_000_000 + 900_000 },
      { token: "t2".padEnd(30, "x"), expiresAt: 1_000_000 + 900_000 + 779_000 },
    ]);
    const seen: string[] = [];
    h.keeper.onChange((t) => seen.push(t));
    expect(await h.keeper.start()).toBe("t1".padEnd(30, "x"));
    expect(await h.keeper.current()).toBe("t1".padEnd(30, "x"));
    // expiry − margin + 1 s from now: 900 − 120 + 1 = 781 s
    expect(h.timers.map((t) => t.ms)).toEqual([781_000]);
    await h.fire();
    expect(h.trades).toHaveLength(2);
    expect(seen).toEqual(["t1".padEnd(30, "x"), "t2".padEnd(30, "x")]);
    expect(await h.keeper.current()).toBe("t2".padEnd(30, "x"));
    expect(h.timers).toHaveLength(1);
  });

  it("does not announce an unchanged token (the session client reused its grant)", async () => {
    const grant = { token: "same".padEnd(30, "x"), expiresAt: 1_000_000 + 300_000 };
    const h = harness([grant, grant]);
    const seen: string[] = [];
    h.keeper.onChange((t) => seen.push(t));
    await h.keeper.start();
    await h.fire();
    expect(seen).toEqual(["same".padEnd(30, "x")]);
  });

  it("keeps the last token and retries soon when a trade fails", async () => {
    const h = harness([
      { token: "t1".padEnd(30, "x"), expiresAt: 1_000_000 + 900_000 },
      new Error("server unreachable"),
      { token: "t2".padEnd(30, "x"), expiresAt: 1_000_000 + 2_000_000 },
    ]);
    await h.keeper.start();
    await h.fire();
    expect(await h.keeper.current()).toBe("t1".padEnd(30, "x"));
    expect(h.timers.map((t) => t.ms)).toEqual([5_000]);
    await h.fire();
    expect(await h.keeper.current()).toBe("t2".padEnd(30, "x"));
  });

  it("never schedules a trade sooner than the retry floor, and stops cleanly", async () => {
    const h = harness([{ token: "t1".padEnd(30, "x"), expiresAt: 1_000_000 + 60_000 }]);
    await h.keeper.start();
    expect(h.timers.map((t) => t.ms)).toEqual([5_000]);
    h.keeper.stop();
    expect(h.timers).toEqual([]);
  });

  it("coalesces concurrent first calls into one trade", async () => {
    const h = harness([{ token: "t1".padEnd(30, "x"), expiresAt: 1_000_000 + 900_000 }]);
    const [a, b] = await Promise.all([h.keeper.current(), h.keeper.current()]);
    expect(a).toBe(b);
    expect(h.trades).toHaveLength(1);
  });
});
