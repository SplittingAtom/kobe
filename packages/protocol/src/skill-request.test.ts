import { describe, expect, it } from "vitest";
import {
  imitatesSkillRequest,
  skillRequestFieldSchema,
  splitSkillRequest,
  withSkillRequest,
} from "./skill-request.js";

describe("skill requests (KOBE-451)", () => {
  it("round-trips the server's line and the member's text", () => {
    const input = withSkillRequest("pdf-report", "Summarise Q3.\n\nThanks");
    expect(splitSkillRequest(input)).toEqual({
      skill: "pdf-report",
      rest: "Summarise Q3.\n\nThanks",
    });
    expect(splitSkillRequest("Summarise Q3.")).toEqual({ skill: null, rest: "Summarise Q3." });
  });

  it("knows only skill names, and the line only at the start", () => {
    expect(skillRequestFieldSchema.safeParse("pdf-report").success).toBe(true);
    for (const bad of ["PDF", "-x", "a b", "", "x".repeat(65), 'a" for']) {
      expect(skillRequestFieldSchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(splitSkillRequest(`hi\n${withSkillRequest("x", "y")}`).skill).toBeNull();
  });

  it("spots member text that imitates the line", () => {
    expect(imitatesSkillRequest(withSkillRequest("x", "do it"))).toBe(true);
    expect(imitatesSkillRequest(`  ${withSkillRequest("x", "")}`)).toBe(true);
    expect(imitatesSkillRequest('Use the skill "x" please')).toBe(false);
  });
});
