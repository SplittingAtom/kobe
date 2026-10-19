import { afterAll, describe, expect, it } from "vitest";
import { createValidatorPool } from "./validate-pool.js";

/** KOBE-436 review HIGH-1: upstream regular expressions never run on the event loop. */
const pool = createValidatorPool({ deadlineMs: 100 });
afterAll(() => pool.close());

const schema = {
  type: "object",
  properties: { q: { type: "string", pattern: "^(\\w+\\s?)*$" } },
};

describe("createValidatorPool", () => {
  it("validates in a worker", async () => {
    expect(await pool.validate(schema, { q: "hello world" })).toBe(true);
    expect(await pool.validate(schema, { q: 7 })).toBe(false);
  });

  it("refuses a catastrophic pattern within the deadline, and keeps serving", async () => {
    const started = Date.now();
    expect(await pool.validate(schema, { q: `${"a".repeat(50)}!` })).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    // The event loop was never blocked, and the replaced worker answers the next call.
    expect(await pool.validate(schema, { q: "ok" })).toBe(true);
  });

  it("fails closed on a schema the validator cannot use", async () => {
    expect(await pool.validate({ $ref: "#/nowhere" }, {})).toBe(false);
  });
});
