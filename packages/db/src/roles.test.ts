import { describe, expect, it } from "vitest";
import { quoteIdent } from "./roles.js";

describe("quoteIdent", () => {
  it("quotes a plain role name", () => {
    expect(quoteIdent("kobe_app")).toBe('"kobe_app"');
  });

  it("rejects names that are not simple identifiers", () => {
    expect(() => quoteIdent('kobe"; DROP TABLE teams; --')).toThrow(/role/i);
    expect(() => quoteIdent("")).toThrow(/role/i);
    expect(() => quoteIdent("a".repeat(64))).toThrow(/role/i);
  });
});
