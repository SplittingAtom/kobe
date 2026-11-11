import { describe, expect, it } from "vitest";
import { changeRows, shown } from "./admin-change";

describe("Admin change before → after rows (KOBE-623)", () => {
  it("pairs from_x with to_x", () => {
    expect(changeRows({ user_id: "u", from_role: "member", to_role: "team_admin" })).toEqual([
      { field: "role", before: "member", after: "team_admin" },
    ]);
  });

  it("pairs from_x with x (an invitation's role)", () => {
    expect(changeRows({ email: "a@b.c", role: "member", from_role: null })).toEqual([
      { field: "role", before: "none", after: "member" },
    ]);
  });

  it("lists each field set in `to` against `from`", () => {
    expect(
      changeRows({ from: { enabled: false, is_default: false }, to: { enabled: true } }),
    ).toEqual([{ field: "enabled", before: "false", after: "true" }]);
  });

  it("handles scalar from/to (a budget removed)", () => {
    expect(changeRows({ user_id: "u", from: { monthly_cents: 100 }, to: null })).toEqual([
      { field: "monthly cents", before: "100", after: "none" },
    ]);
    expect(changeRows({ from: 1, to: null })).toEqual([
      { field: "value", before: "1", after: "none" },
    ]);
  });

  it("says when only the before-state is named (a removal)", () => {
    expect(changeRows({ connector_id: "c", from_exposure: "all" })).toEqual([
      { field: "exposure", before: "all", after: "(unchanged target)" },
    ]);
  });

  it("shows nothing for inputs without a before-state, and values as text", () => {
    expect(changeRows({ domain: "x.com" })).toEqual([]);
    expect(changeRows(null)).toEqual([]);
    expect(shown({ a: 1 })).toBe('{"a":1}');
  });
});
