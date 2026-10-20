import { describe, expect, it } from "vitest";
import {
  closedWindow,
  configureUsageKey,
  fromPayload,
  toPayload,
  userKey,
  windowKey,
  type UsageSnapshot,
} from "./usage-snapshot.js";

/** KOBE-339 review M2: fixed, non-overlapping 30-day windows from the epoch. */
describe("the usage window", () => {
  it("is the last closed 30-day period counted from the epoch", () => {
    // Periods start every 30 days from 1970-01-01; 2026-10-04 starts the one 2026-10-19 is in.
    expect(closedWindow(new Date("2026-10-19T15:30:00.000Z"))).toEqual({
      from: "2026-09-04T00:00:00.000Z",
      to: "2026-10-04T00:00:00.000Z",
    });
  });

  it("never overlaps: every day of a period answers the same window, the next one the next", () => {
    const a = closedWindow(new Date("2026-10-04T00:00:00.000Z"));
    const b = closedWindow(new Date("2026-11-02T23:59:59.999Z"));
    expect(a).toEqual(b);
    const c = closedWindow(new Date("2026-11-03T00:00:00.000Z"));
    expect(c.from).toBe(a.to);
  });

  it("keys members by an HMAC of the window under the server's secret, never stored (341 L1)", () => {
    configureUsageKey("a".repeat(32));
    const a = windowKey("2026-09-04T00:00:00.000Z");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(windowKey("2026-10-04T00:00:00.000Z")).not.toBe(a);
    expect(
      JSON.stringify(
        toPayload({ from: "x", to: "y", computedAt: "z", salt: a, skills: new Map() }),
      ),
    ).not.toContain(a);
    configureUsageKey("b".repeat(32));
    expect(windowKey("2026-09-04T00:00:00.000Z")).not.toBe(a);
    expect(userKey(a, "u")).not.toBe(userKey(windowKey("2026-09-04T00:00:00.000Z"), "u"));
  });

  it("ignores a payload stored before member keys (341 L2)", () => {
    configureUsageKey("a".repeat(32));
    expect(fromPayload({ skills: {} }, { from: "a", to: "b", computedAt: "c" })).toBeNull();
  });

  it("stores and reads back each team's part", () => {
    configureUsageKey("a".repeat(32));
    const s: UsageSnapshot = {
      from: "a",
      to: "b",
      computedAt: "c",
      salt: "",
      skills: new Map([
        [
          "s",
          new Map([
            [
              "t",
              {
                installed: true,
                running: "1.0.0",
                optedOut: false,
                runs: new Map([["1.0.0", 2]]),
                members: new Map([["1.0.0", new Set(["u"])]]),
                up: new Map([["1.0.0", 1]]),
                down: new Map(),
                raters: new Map([["1.0.0", new Set(["u"])]]),
              },
            ],
          ]),
        ],
      ]),
    };
    expect(fromPayload(toPayload(s), { from: "a", to: "b", computedAt: "c" })).toEqual({
      ...s,
      salt: windowKey("a"),
    });
  });
});
