import { describe, expect, it } from "vitest";
import { readBudgetStopScope } from "./runs.js";

describe("readBudgetStopScope (KOBE-256)", () => {
  it("reads the stop scope of runs stopped before the rename as site", () => {
    expect(readBudgetStopScope("install")).toBe("site");
    expect(readBudgetStopScope("site")).toBe("site");
    expect(readBudgetStopScope("team")).toBe("team");
    expect(readBudgetStopScope("user")).toBe("user");
    expect(readBudgetStopScope(null)).toBeNull();
    expect(readBudgetStopScope("everyone")).toBeNull();
  });
});
