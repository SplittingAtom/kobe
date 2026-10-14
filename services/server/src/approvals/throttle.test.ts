import { describe, expect, it } from "vitest";
import { AuditThrottle } from "./throttle.js";

describe("AuditThrottle", () => {
  it("records the first of a key per window and counts the repeats into its next row", () => {
    let now = 0;
    const t = new AuditThrottle({ windowMs: 1_000, now: () => now });
    expect(t.take("a")).toEqual({ record: true, suppressed: 0 });
    expect(t.take("a")).toEqual({ record: false });
    expect(t.take("a")).toEqual({ record: false });
    expect(t.take("b")).toEqual({ record: true, suppressed: 0 });
    now = 1_000;
    expect(t.take("a")).toEqual({ record: true, suppressed: 2 });
  });

  it("stays bounded: prunes expired keys, then the oldest", () => {
    let now = 0;
    const t = new AuditThrottle({ windowMs: 1_000, maxKeys: 3, now: () => now });
    for (const k of ["a", "b", "c"]) t.take(k);
    now = 2_000;
    t.take("d");
    expect(t.size).toBe(1);
    for (const k of ["e", "f", "g"]) t.take(k);
    expect(t.size).toBe(3);
    // The oldest ("d") went first: it records again at once.
    expect(t.take("d")).toEqual({ record: true, suppressed: 0 });
  });

  it("undoes a take whose audit row rolled back, so the retry records it (KOBE-266)", () => {
    let now = 0;
    const t = new AuditThrottle({ windowMs: 1_000, now: () => now });
    const first = t.reserve("a");
    expect(first.decision).toEqual({ record: true, suppressed: 0 });
    first.undo();
    expect(t.take("a")).toEqual({ record: true, suppressed: 0 });
    // A suppressed repeat that rolled back is not counted twice.
    const repeat = t.reserve("a");
    expect(repeat.decision).toEqual({ record: false });
    repeat.undo();
    expect(t.take("a")).toEqual({ record: false });
    now = 1_000;
    expect(t.take("a")).toEqual({ record: true, suppressed: 1 });
  });

  it("an undo restores the key's previous row and its count, and is a no-op once superseded", () => {
    let now = 0;
    const t = new AuditThrottle({ windowMs: 1_000, now: () => now });
    t.take("a");
    t.take("a");
    now = 1_000;
    const again = t.reserve("a");
    expect(again.decision).toEqual({ record: true, suppressed: 1 });
    again.undo();
    expect(t.take("a")).toEqual({ record: true, suppressed: 1 });
    const stale = t.reserve("b");
    t.take("b"); // a later repeat of the same key, kept...
    stale.undo(); // ...makes the earlier undo stale: it changes nothing
    now = 2_000;
    expect(t.take("b")).toEqual({ record: true, suppressed: 1 });
  });
});
