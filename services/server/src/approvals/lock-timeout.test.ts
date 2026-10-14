import { describe, expect, it } from "vitest";
import { isLockTimeout, retryableLockConflict } from "./broker.js";

describe("isLockTimeout", () => {
  it("sees 55P03 directly and through Drizzle's cause", () => {
    expect(isLockTimeout({ code: "55P03" })).toBe(true);
    expect(isLockTimeout(new Error("wrapped", { cause: { code: "55P03" } }))).toBe(true);
  });
  it("ignores other errors", () => {
    expect(isLockTimeout({ code: "40P01" })).toBe(false);
    expect(isLockTimeout(new Error("x"))).toBe(false);
    expect(isLockTimeout(undefined)).toBe(false);
  });
});

describe("retryableLockConflict (KOBE-266)", () => {
  it("names a lock timeout or a deadlock, directly and through Drizzle's cause", () => {
    expect(retryableLockConflict({ code: "55P03" })).toBe("55P03");
    expect(retryableLockConflict(new Error("wrapped", { cause: { code: "40P01" } }))).toBe("40P01");
  });
  it("is undefined for anything else (those are never retried)", () => {
    expect(retryableLockConflict({ code: "40001" })).toBeUndefined();
    expect(retryableLockConflict({ code: "23505" })).toBeUndefined();
    expect(retryableLockConflict(new Error("x"))).toBeUndefined();
    expect(retryableLockConflict(undefined)).toBeUndefined();
  });
});
