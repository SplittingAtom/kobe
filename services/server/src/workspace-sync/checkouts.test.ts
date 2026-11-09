import { describe, expect, it } from "vitest";
import { isReadOnlyPath, moveRefusal } from "../workspace-files/paths.js";
import { checkoutOf } from "./checkouts.js";

describe("checkouts in the workspace (KOBE-579, CM3/CM4)", () => {
  const mine = new Set(["alpha"]);

  it("finds the checkout a path lies strictly inside", () => {
    expect(checkoutOf("projects/alpha/a.md", mine)).toBe("alpha");
    expect(checkoutOf("projects/alpha/dir/a.md", mine)).toBe("alpha");
    expect(checkoutOf("projects/alpha", mine)).toBeUndefined();
    expect(checkoutOf("projects/alpha/", mine)).toBeUndefined();
    expect(checkoutOf("projects/beta/a.md", mine)).toBeUndefined();
    expect(checkoutOf("projects/alphabet/a.md", mine)).toBeUndefined();
    expect(checkoutOf("notes/projects/alpha/a.md", mine)).toBeUndefined();
    expect(checkoutOf("projects", mine)).toBeUndefined();
  });

  it("makes only the caller's checked-out folders writable", () => {
    expect(isReadOnlyPath("projects/alpha/a.md")).toBe(true);
    expect(isReadOnlyPath("projects/alpha/a.md", mine)).toBe(false);
    expect(isReadOnlyPath("projects/beta/a.md", mine)).toBe(true);
    expect(isReadOnlyPath("projects/alpha", mine)).toBe(true);
    expect(isReadOnlyPath("uploads/t/f.md", mine)).toBe(true);
    expect(isReadOnlyPath("notes.md", mine)).toBe(false);
    expect(moveRefusal("projects/alpha/a.md", "projects/alpha/b.md", mine)).toBeUndefined();
    expect(moveRefusal("projects/alpha/a.md", "projects/beta/a.md", mine)?.code).toBe("read_only");
    expect(moveRefusal("projects/alpha/a.md", "notes/a.md")?.code).toBe("read_only");
  });
});
