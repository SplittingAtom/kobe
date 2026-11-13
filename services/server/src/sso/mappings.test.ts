import { describe, expect, it } from "vitest";
import { parseCreateMapping } from "./mappings.js";

const TEAM = "00000000-0000-4000-8000-000000000001";

describe("parseCreateMapping (SSO6)", () => {
  it("accepts a team role mapping", () => {
    for (const role of ["member", "contributor", "team_admin"]) {
      expect(parseCreateMapping({ claimValue: "kobe.fin.member", teamId: TEAM, role })).toEqual({
        ok: true,
        value: { claimValue: "kobe.fin.member", teamId: TEAM, role },
      });
    }
    // Group names of generic providers may hold inner spaces; Entra group ids are GUIDs.
    expect(
      parseCreateMapping({ claimValue: "Domain Users", teamId: TEAM, role: "member" }).ok,
    ).toBe(true);
  });

  it("refuses site roles with their own code", () => {
    for (const role of ["owner", "admin", "ADMIN", "site_admin", "site_owner"]) {
      expect(parseCreateMapping({ claimValue: "x", teamId: TEAM, role })).toEqual({
        ok: false,
        error: "site_role_not_mappable",
      });
    }
  });

  it("refuses bad values, unknown roles and extra fields", () => {
    const bad = [
      null,
      "x",
      { claimValue: "x", teamId: TEAM, role: "boss" },
      { claimValue: "x", teamId: "nope", role: "member" },
      { claimValue: "", teamId: TEAM, role: "member" },
      { claimValue: " x", teamId: TEAM, role: "member" },
      { claimValue: "x\n", teamId: TEAM, role: "member" },
      { claimValue: "a\u0000b", teamId: TEAM, role: "member" },
      { claimValue: "x".repeat(257), teamId: TEAM, role: "member" },
      { claimValue: "x", teamId: TEAM, role: "member", siteRole: "admin" },
    ];
    for (const body of bad) {
      expect(parseCreateMapping(body), JSON.stringify(body)).toEqual({
        ok: false,
        error: "invalid_request",
      });
    }
  });
});
