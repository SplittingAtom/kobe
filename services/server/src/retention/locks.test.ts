import type { KobeDb } from "@kobe/db";
import { describe, expect, it } from "vitest";
import { isLockConflict } from "./locks.js";
import { purgeThreads } from "./purge.js";

const TEAM = "00000000-0000-4000-8000-000000000001";
const pgError = (code: string) => Object.assign(new Error("Failed query"), { cause: { code } });
/** A database whose every transaction fails with `err`. */
const failingDb = (err: unknown) =>
  ({ transaction: () => Promise.reject(err) }) as unknown as KobeDb;

describe("isLockConflict (KOBE-216 ac-4)", () => {
  it("knows a lock timeout and a deadlock, on the error or its cause", () => {
    expect(isLockConflict({ code: "55P03" })).toBe(true);
    expect(isLockConflict(pgError("40P01"))).toBe(true);
    expect(isLockConflict(pgError("23503"))).toBe(false);
    expect(isLockConflict(new Error("x"))).toBe(false);
    expect(isLockConflict(undefined)).toBe(false);
  });
});

describe("purgeThreads on a lock conflict", () => {
  it.each(["55P03", "40P01"])("stops as busy on %s instead of failing the step", async (code) => {
    const outcome = await purgeThreads(failingDb(pgError(code)), TEAM, { kind: "trash" }, () =>
      Promise.resolve(),
    );
    expect(outcome).toEqual({
      status: "busy",
      counts: { threads: 0, entries: 0, runs: 0, events: 0, blobs: 0 },
    });
  });

  it("still throws any other error", async () => {
    const err = pgError("XX000");
    await expect(
      purgeThreads(failingDb(err), TEAM, { kind: "trash" }, () => Promise.resolve()),
    ).rejects.toBe(err);
  });
});
