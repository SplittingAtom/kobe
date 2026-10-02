import { describe, expect, it } from "vitest";
import { validateSetup } from "./setup";

describe("validateSetup", () => {
  const ok = { email: "owner@example.com", name: "Owner", password: "correct horse battery" };

  it("accepts valid input", () => {
    expect(validateSetup(ok)).toBeNull();
  });

  it.each([
    [{ ...ok, email: "nope" }, /email/],
    [{ ...ok, name: "  " }, /name/],
    [{ ...ok, password: "short" }, /12 characters/],
    [{ ...ok, password: "x".repeat(129) }, /128/],
  ])("rejects %o", (input, message) => {
    expect(validateSetup(input)).toMatch(message);
  });
});
