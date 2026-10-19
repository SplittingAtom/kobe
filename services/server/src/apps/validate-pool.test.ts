import type { Worker } from "node:worker_threads";
import { afterAll, describe, expect, it } from "vitest";
import { WORKER_RESOURCE_LIMITS, createValidatorPool } from "./validate-pool.js";

/** KOBE-436 review HIGH-1: upstream regular expressions never run on the event loop. */
const spawned: Worker["resourceLimits"][] = [];
// A worker reports its limits only while it runs, so they are read at spawn.
const pool = createValidatorPool({
  deadlineMs: 100,
  onSpawn: (w) => spawned.push({ ...w.resourceLimits }),
});
afterAll(() => pool.close());

const schema = {
  type: "object",
  properties: { q: { type: "string", pattern: "^(\\w+\\s?)*$" } },
};
const SLOW = { q: `${"a".repeat(50)}!` };

describe("createValidatorPool", () => {
  it("validates in a worker", async () => {
    expect(await pool.validate(schema, { q: "hello world" }, "u1")).toBe("valid");
    expect(await pool.validate(schema, { q: 7 }, "u1")).toBe("invalid");
  });

  it("refuses a catastrophic pattern within the deadline, and keeps serving", async () => {
    const started = Date.now();
    expect(await pool.validate(schema, SLOW, "u1")).toBe("invalid");
    expect(Date.now() - started).toBeLessThan(1000);
    // The event loop was never blocked, and the replaced worker answers the next call.
    expect(await pool.validate(schema, { q: "ok" }, "u1")).toBe("valid");
  });

  it("never counts a worker's start-up against the deadline (CI: a cold worker took 135 ms)", async () => {
    const cold = createValidatorPool({ deadlineMs: 25, size: 1 });
    try {
      // 25 ms is below a cold worker's start-up, but a task waits for a ready worker first.
      expect(await cold.validate({ type: "object" }, {}, "u1")).toBe("valid");
    } finally {
      await cold.close();
    }
  });

  it("fails closed on a schema the validator cannot use", async () => {
    expect(await pool.validate({ $ref: "#/nowhere" }, {}, "u1")).toBe("invalid");
  });

  it("caps each worker's heap (re-review R-LOW-2)", () => {
    expect(spawned.length).toBeGreaterThan(0);
    for (const limits of spawned) expect(limits).toMatchObject(WORKER_RESOURCE_LIMITS);
  });
});

describe("fair use (re-review R-LOW-1)", () => {
  it("takes one task per owner; a second one is busy, not invalid", async () => {
    const p = createValidatorPool({ deadlineMs: 100 });
    try {
      const first = p.validate(schema, SLOW, "u1");
      expect(await p.validate(schema, { q: "ok" }, "u1")).toBe("busy");
      // Another member is not held up by u1's slot.
      expect(await p.validate(schema, { q: "ok" }, "u2")).toBe("valid");
      expect(await first).toBe("invalid");
      // Once u1's task is done, u1 is served again.
      expect(await p.validate(schema, { q: "ok" }, "u1")).toBe("valid");
    } finally {
      await p.close();
    }
  });

  it("answers busy when the queue is full", async () => {
    const p = createValidatorPool({ deadlineMs: 100, size: 1, maxQueue: 1 });
    try {
      // Its one worker is up (a task waits in the queue until a worker has loaded its library).
      expect(await p.validate(schema, { q: "ok" }, "warm")).toBe("valid");
      const running = p.validate(schema, SLOW, "a");
      const queued = p.validate(schema, { q: "ok" }, "b");
      expect(await p.validate(schema, { q: "ok" }, "c")).toBe("busy");
      expect(await running).toBe("invalid");
      expect(await queued).toBe("valid");
    } finally {
      await p.close();
    }
  });

  it("answers busy once closed", async () => {
    const p = createValidatorPool();
    await p.close();
    expect(await p.validate(schema, {}, "u1")).toBe("busy");
  });
});
