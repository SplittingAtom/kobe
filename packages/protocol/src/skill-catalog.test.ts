import { describe, expect, it } from "vitest";
import {
  INSTALLABLE_VERSION_STATES,
  PUBLISHED_VERSION_STATES,
  REGISTRY_VERSION_STATES,
  SKILL_ACCESS_MODES,
  SKILL_PIN_MODES,
  SYSTEM_TAGS,
  putMemberSkillAddSchema,
  putSkillTagsSchema,
  putTeamSkillInstallSchema,
  skillRefSchema,
  teamSkillInstallSchema,
} from "./skill-catalog.js";

const ID = "7f3c2a10-1b2c-4d5e-8f90-0a1b2c3d4e5f";

describe("skill catalog contract (KOBE-311)", () => {
  it("names the closed sets of the spec", () => {
    expect(SKILL_PIN_MODES).toEqual(["pinned", "within_major", "latest"]);
    expect(SKILL_ACCESS_MODES).toEqual(["available", "default_on", "required", "hidden"]);
    expect(SYSTEM_TAGS).toEqual(["default"]);
    for (const s of [...PUBLISHED_VERSION_STATES, ...INSTALLABLE_VERSION_STATES])
      expect(REGISTRY_VERSION_STATES).toContain(s);
  });

  it("takes an install by semver, pin mode and access mode", () => {
    expect(
      putTeamSkillInstallSchema.safeParse({
        version: "1.3.0",
        pinMode: "within_major",
        access: "default_on",
      }).success,
    ).toBe(true);
    for (const bad of [
      { version: "1.3", pinMode: "pinned", access: "available" },
      { version: "1.3.0", pinMode: "major", access: "available" },
      { version: "1.3.0", pinMode: "pinned", access: "everyone" },
      { version: "1.3.0", pinMode: "pinned", access: "available", origin: "default_tag" },
    ])
      expect(putTeamSkillInstallSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(putMemberSkillAddSchema.safeParse({ version: "2.0.0", pinMode: "latest" }).success).toBe(
      true,
    );
  });

  it("describes an install as the API returns it", () => {
    const install = {
      skillId: ID,
      name: "quarterly-report",
      versionId: ID,
      semver: "1.3.0",
      pinMode: "pinned",
      access: "required",
      origin: "default_tag",
      installedBy: ID,
      updatedAt: "2026-10-18T10:00:00.000Z",
    };
    expect(teamSkillInstallSchema.parse(install)).toEqual(install);
  });

  it("refers to a catalog or a team skill, nothing else", () => {
    expect(skillRefSchema.safeParse({ kind: "catalog", skillId: ID }).success).toBe(true);
    expect(skillRefSchema.safeParse({ kind: "team", skillId: ID }).success).toBe(true);
    expect(skillRefSchema.safeParse({ kind: "personal", skillId: ID }).success).toBe(false);
    expect(skillRefSchema.safeParse({ kind: "catalog", skillId: "x" }).success).toBe(false);
  });

  it("accepts only code-defined system tags", () => {
    expect(putSkillTagsSchema.safeParse({ system: ["default"], topic: ["finance"] }).success).toBe(
      true,
    );
    expect(putSkillTagsSchema.safeParse({ system: ["featured"], topic: [] }).success).toBe(false);
    expect(putSkillTagsSchema.safeParse({ system: [], topic: ["Finance"] }).success).toBe(false);
  });
});
