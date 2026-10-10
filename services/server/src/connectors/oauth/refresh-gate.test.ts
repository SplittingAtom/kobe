import { describe, expect, it } from "vitest";
import { RefreshGate } from "./refresh-gate.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe("RefreshGate", () => {
  it("shares one flight among concurrent callers of a key", async () => {
    const gate = new RefreshGate();
    const d = deferred();
    let runs = 0;
    const fn = async () => {
      runs += 1;
      await d.promise;
      return runs;
    };
    const all = [gate.run("a", fn), gate.run("a", fn), gate.run("a", fn)];
    d.resolve();
    expect(await Promise.all(all)).toEqual([1, 1, 1]);
    expect(await gate.run("a", fn)).toBe(2);
  });

  it("caps concurrent flights and starts queued ones as slots free", async () => {
    const gate = new RefreshGate({ maxConcurrent: 2 });
    const gates = [deferred(), deferred(), deferred()];
    let active = 0;
    let peak = 0;
    const flights = gates.map((d, i) =>
      gate.run(`k${i}`, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await d.promise;
        active -= 1;
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(active).toBe(2);
    gates[0]?.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(active).toBe(2);
    gates.forEach((d) => d.resolve());
    await Promise.all(flights);
    expect(peak).toBe(2);
  });

  it("backs off a failed key until the window passes", () => {
    let now = 0;
    const gate = new RefreshGate({ backoffMs: 30_000, now: () => now });
    gate.markFailed("a");
    expect(gate.inBackoff("a")).toBe(true);
    expect(gate.inBackoff("b")).toBe(false);
    now = 30_001;
    expect(gate.inBackoff("a")).toBe(false);
  });

  it("releases its slot when a flight throws", async () => {
    const gate = new RefreshGate({ maxConcurrent: 1 });
    await expect(gate.run("a", () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(await gate.run("b", () => Promise.resolve(1))).toBe(1);
  });
});
