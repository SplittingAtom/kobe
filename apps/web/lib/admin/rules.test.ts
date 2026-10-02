import { describe, expect, it } from "vitest";
import {
  TEAM_SLUG_RE,
  canChangeActivation,
  canManageInstallRoles,
  canTurnOffRequiredTwoFactor,
  slugFromTeamName,
} from "./rules";
import { TEAM_SLUG_PATTERN } from "./api/install/teams";

describe("canChangeActivation", () => {
  const owner = { userId: "o", role: "owner" as const };
  const admin = { userId: "a", role: "admin" as const };
  it.each([
    [owner, { id: "u", installRole: "user" as const }, true],
    [owner, { id: "a2", installRole: "admin" as const }, true],
    [owner, { id: "o", installRole: "owner" as const }, false],
    [admin, { id: "u", installRole: "user" as const }, true],
    [admin, { id: "a2", installRole: "admin" as const }, false],
    [admin, { id: "o", installRole: "owner" as const }, false],
    [admin, { id: "a", installRole: "admin" as const }, false],
    [{ userId: "x", role: "user" as const }, { id: "u", installRole: "user" as const }, false],
  ])("%j on %j → %s", (me, target, expected) => {
    expect(canChangeActivation(me, target)).toBe(expected);
  });
});

describe("owner-only actions", () => {
  it("are the Owner's", () => {
    expect(canManageInstallRoles("owner")).toBe(true);
    expect(canManageInstallRoles("admin")).toBe(false);
    expect(canTurnOffRequiredTwoFactor("owner")).toBe(true);
    expect(canTurnOffRequiredTwoFactor("admin")).toBe(false);
  });
});

describe("team slugs", () => {
  it.each([
    ["Finance", "finance"],
    ["  Marketing & Sales!  ", "marketing-sales"],
    ["Équipe Données", "equipe-donnees"],
    ["x".repeat(40), "x".repeat(32)],
    ["a".repeat(31) + " b", "a".repeat(31)],
    ["***", ""],
  ])("%j → %j", (name, slug) => {
    expect(slugFromTeamName(name)).toBe(slug);
    if (slug) expect(TEAM_SLUG_RE.test(slug)).toBe(true);
  });

  it("uses the same rule in the form pattern and the check", () => {
    const pattern = new RegExp(`^(?:${TEAM_SLUG_PATTERN})$`, "v");
    for (const s of ["a", "fin-ops", "a1", "-a", "a-", "A", "a".repeat(33)]) {
      expect(pattern.test(s)).toBe(TEAM_SLUG_RE.test(s));
    }
  });
});
