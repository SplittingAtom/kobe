import { describe, expect, it } from "vitest";
import { editDistance, isReservedName, similarNames } from "./names.js";

describe("catalog names (KOBE-332, SK24)", () => {
  it("reserves Kobe's built-in names", () => {
    for (const n of ["skill-creator", "pdf", "xlsx", "data-analysis"])
      expect(isReservedName(n), n).toBe(true);
    expect(isReservedName("pdf-tools")).toBe(false);
  });

  it("measures edit distance", () => {
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("abc", "abc")).toBe(0);
    expect(editDistance("", "ab")).toBe(2);
  });

  it("hints at near names: small edits and hyphen variants, never the name itself", () => {
    const existing = ["invoice-checker", "pdf", "sales-report", "weekly-digest", "invoicechecker"];
    expect(similarNames("invoice-checkr", existing)).toEqual(["invoice-checker", "invoicechecker"]);
    expect(similarNames("salesreport", existing)).toEqual(["sales-report"]);
    expect(similarNames("sales-reports", existing)).toEqual(["sales-report"]);
    expect(similarNames("pdg", existing)).toEqual(["pdf"]);
    expect(similarNames("sales-report", existing)).toEqual([]);
    expect(similarNames("budget-planner", existing)).toEqual([]);
    // Short names allow one edit only.
    expect(similarNames("abc", ["xyz", "abd", "axd"])).toEqual(["abd"]);
  });
});
