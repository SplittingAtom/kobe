import { describe, expect, it } from "vitest";
import {
  isForeignKeyViolation,
  isLockConflict,
  isLockTimeout,
  isUniqueViolation,
  pgCodeOf,
} from "./pg-errors.js";

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

  it("matches a unique violation, with or without a constraint, however deep it is wrapped", () => {
    const err = wrapped({ code: "23505", constraint: "projects_slug_unique" });
    const twice = Object.assign(new Error("rethrown"), { cause: err });
    expect(isUniqueViolation(err)).toBe(true);
    expect(isUniqueViolation(twice)).toBe(true);
    expect(isUniqueViolation(twice, "projects_slug_unique")).toBe(true);
    expect(isUniqueViolation(err, "other_unique")).toBe(false);
    expect(isUniqueViolation(wrapped({ code: "23503" }))).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });

  it("reads a SQLSTATE two causes deep, which the old one-level copies missed", () => {
    const twice = Object.assign(new Error("rethrown"), { cause: wrapped({ code: "23514" }) });
    expect(pgCodeOf(twice)).toBe("23514");
  });
});
