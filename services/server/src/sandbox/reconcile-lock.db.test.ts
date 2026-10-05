import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";
import { createPgReconcileLock } from "./reconcile-lock.js";

/** The team-namespace reconcile lock against real Postgres (KOBE-115). */
let pool: pg.Pool;
beforeAll(() => {
  pool = new pg.Pool({ connectionString: inject("appUrl"), max: 4 });
});
afterAll(async () => {
  await pool.end();
});

describe("createPgReconcileLock", () => {
  it("lets one replica work at a time and frees the lock afterwards", async () => {
    const a = createPgReconcileLock(pool);
    const b = createPgReconcileLock(pool);
    let inner: unknown;
    const first = await a.runExclusive(async () => {
      inner = await b.runExclusive(() => Promise.resolve("never"));
      return "a";
    });
    expect(first).toEqual({ ran: true, value: "a" });
    expect(inner).toEqual({ ran: false });
    await expect(b.runExclusive(() => Promise.resolve("b"))).resolves.toEqual({
      ran: true,
      value: "b",
    });
  });

  it("releases the lock when the work throws", async () => {
    const lock = createPgReconcileLock(pool);
    await expect(lock.runExclusive(() => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    await expect(lock.runExclusive(() => Promise.resolve(1))).resolves.toEqual({
      ran: true,
      value: 1,
    });
  });
});
