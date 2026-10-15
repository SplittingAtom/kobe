import type { KobeDb } from "@kobe/db";
import { describe, expect, it } from "vitest";
import { purgeThreads } from "./purge.js";

const TEAM = "00000000-0000-4000-8000-000000000001";
const pgError = (code: string) => Object.assign(new Error("Failed query"), { cause: { code } });
/** A database whose every transaction fails with `err`. */
const failingDb = (err: unknown) =>
  ({ transaction: () => Promise.reject(err) }) as unknown as KobeDb;

describe("purgeThreads on a lock conflict (KOBE-216 ac-4)", () => {
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
