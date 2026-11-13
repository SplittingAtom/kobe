import { describe, expect, it } from "vitest";
import { memoryPlan } from "./run-memory.js";

describe("memoryPlan (KOBE-646)", () => {
  it("all gives Notes and semantic memory, notes_only Notes, off nothing", () => {
    expect(memoryPlan("all")).toEqual({ setting: "all", notes: true, semantic: true });
    expect(memoryPlan("notes_only")).toEqual({
      setting: "notes_only",
      notes: true,
      semantic: false,
    });
    expect(memoryPlan("off")).toEqual({ setting: "off", notes: false, semantic: false });
  });

  it("a test chat never gets semantic memory; a skill eval gets none whatever the setting", () => {
    expect(memoryPlan("all", "test_chat")).toEqual({
      setting: "all",
      notes: true,
      semantic: false,
    });
    expect(memoryPlan("off", "test_chat")).toMatchObject({ notes: false, semantic: false });
    for (const setting of ["all", "notes_only", "off"] as const) {
      expect(memoryPlan(setting, "skill_eval")).toMatchObject({ notes: false, semantic: false });
    }
  });
});
