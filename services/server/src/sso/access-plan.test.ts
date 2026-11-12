import { describe, expect, it } from "vitest";
import {
  desiredTeamRoles,
  higherRole,
  normalizeIdpValues,
  planTeam,
  MAX_IDP_VALUES,
} from "./access-plan.js";

const T1 = "00000000-0000-4000-8000-000000000001";
const T2 = "00000000-0000-4000-8000-000000000002";
const P = "00000000-0000-4000-8000-0000000000aa";
const OTHER = "00000000-0000-4000-8000-0000000000bb";
const tag = `idp:${P}`;

describe("higherRole", () => {
  it("ranks team admin over contributor over member", () => {
    expect(higherRole("member", "contributor")).toBe("contributor");
    expect(higherRole("team_admin", "contributor")).toBe("team_admin");
    expect(higherRole("member", "member")).toBe("member");
  });
});

describe("normalizeIdpValues", () => {
  it("drops non-strings, empty and over-long values and duplicates", () => {
    expect(normalizeIdpValues(["a", "a", "", "b", 3, null, "x".repeat(257)])).toEqual(["a", "b"]);
    expect(normalizeIdpValues("a")).toEqual([]);
  });

  it("refuses more values than any token or SCIM user carries", () => {
    const many = Array.from({ length: MAX_IDP_VALUES + 1 }, (_, i) => `v${i}`);
    expect(() => normalizeIdpValues(many)).toThrow(/too many/);
  });
});

describe("desiredTeamRoles (§7 rule 1)", () => {
  const mappings = [
    { claimValue: "kobe.fin.member", teamId: T1, role: "member" as const },
    { claimValue: "kobe.fin.admin", teamId: T1, role: "team_admin" as const },
    { claimValue: "kobe.fin.builder", teamId: T1, role: "contributor" as const },
    { claimValue: "kobe.mkt.member", teamId: T2, role: "member" as const },
  ];

  it("takes the highest role among the matched mappings per team", () => {
    const d = desiredTeamRoles(mappings, [
      "kobe.fin.member",
      "kobe.fin.builder",
      "kobe.mkt.member",
    ]);
    expect(Object.fromEntries(d)).toEqual({ [T1]: "contributor", [T2]: "member" });
    expect(desiredTeamRoles(mappings, ["kobe.fin.admin", "kobe.fin.member"]).get(T1)).toBe(
      "team_admin",
    );
  });

  it("matches values exactly (case and whitespace matter)", () => {
    expect(desiredTeamRoles(mappings, ["KOBE.FIN.ADMIN", " kobe.fin.admin"]).size).toBe(0);
  });

  it("is empty when no value matches (§7 rule 5)", () => {
    expect(desiredTeamRoles(mappings, []).size).toBe(0);
  });

  it("never yields a site role, even from a corrupt mapping (SSO6)", () => {
    const bad = [{ claimValue: "x", teamId: T1, role: "admin" as never }];
    expect(() => desiredTeamRoles(bad, ["x"])).toThrow(/site role|team role/);
  });
});

describe("planTeam (§7 rules 2-4)", () => {
  it("adds a managed row when the team is desired and the user has none", () => {
    expect(planTeam({ row: null, desired: "member", tag })).toEqual({
      kind: "add",
      role: "member",
    });
  });

  it("does nothing when neither desired nor a member", () => {
    expect(planTeam({ row: null, desired: undefined, tag })).toEqual({ kind: "none" });
  });

  it("updates a managed row whose role differs, removes one no longer desired", () => {
    const row = { role: "member" as const, addedVia: tag };
    expect(planTeam({ row, desired: "team_admin", tag })).toEqual({
      kind: "change",
      from: "member",
      to: "team_admin",
    });
    expect(planTeam({ row, desired: "member", tag })).toEqual({ kind: "none" });
    expect(planTeam({ row, desired: undefined, tag })).toEqual({ kind: "remove", role: "member" });
  });

  it("never touches a manual row; a differing desire is a conflict (manual wins)", () => {
    const row = { role: "member" as const, addedVia: null };
    expect(planTeam({ row, desired: "team_admin", tag })).toEqual({ kind: "conflict" });
    expect(planTeam({ row, desired: "member", tag })).toEqual({ kind: "none" });
    expect(planTeam({ row, desired: undefined, tag })).toEqual({ kind: "none" });
  });

  it("treats rows of another provider or the Skill reviewer grant as not its own", () => {
    for (const addedVia of [`idp:${OTHER}`, "skill_reviewer_grant"]) {
      const row = { role: "member" as const, addedVia };
      expect(planTeam({ row, desired: undefined, tag })).toEqual({ kind: "none" });
      expect(planTeam({ row, desired: "contributor", tag })).toEqual({ kind: "conflict" });
    }
  });
});
