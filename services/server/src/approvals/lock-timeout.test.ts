import { describe, expect, it } from "vitest";
import { isLockTimeout } from "./broker.js";

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
