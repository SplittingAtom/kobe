import { describe, expect, it } from "vitest";
import { isForeignKeyViolation, isLockConflict, isLockTimeout, pgCodeOf } from "./pg-errors.js";

const wrapped = (fields: Record<string, unknown>) =>
  Object.assign(new Error("Failed query"), { cause: Object.assign(new Error("db"), fields) });

describe("pg error helpers", () => {
  it("reads the SQLSTATE on the error or down its cause chain", () => {
    expect(pgCodeOf({ code: "55P03" })).toBe("55P03");
    expect(pgCodeOf(wrapped({ code: "40P01" }))).toBe("40P01");
    expect(pgCodeOf(new Error("x"))).toBeUndefined();
    expect(pgCodeOf({ code: "ECONNRESET" })).toBeUndefined();
    expect(pgCodeOf(undefined)).toBeUndefined();
  });

  it("names lock timeouts and lock conflicts", () => {
    expect(isLockTimeout(wrapped({ code: "55P03" }))).toBe(true);
    expect(isLockTimeout(wrapped({ code: "40P01" }))).toBe(false);
    expect(isLockConflict(wrapped({ code: "40P01" }))).toBe(true);
    expect(isLockConflict(wrapped({ code: "23503" }))).toBe(false);
  });

  it("matches a foreign-key violation by constraint", () => {
    const err = wrapped({ code: "23503", constraint: "threads_forked_from_fk" });
    expect(isForeignKeyViolation(err, "threads_forked_from_fk")).toBe(true);
    expect(isForeignKeyViolation(err, "other_fk")).toBe(false);
    expect(isForeignKeyViolation(wrapped({ code: "23505" }), "threads_forked_from_fk")).toBe(false);
  });
});
