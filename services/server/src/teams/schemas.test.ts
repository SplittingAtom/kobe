import { describe, expect, it } from "vitest";
import {
  addMemberSchema,
  createTeamSchema,
  installRoleChangeSchema,
  memberRoleSchema,
  teamSlugSchema,
} from "./schemas.js";

const id = "6f1c1f9e-8f5a-4c1e-9b8a-2f1d3c4b5a69";

describe("team slug", () => {
  it.each(["a", "finance", "team-1", "a".repeat(32)])("accepts %s", (slug) => {
    expect(teamSlugSchema.safeParse(slug).success).toBe(true);
  });

  it.each(["", "-a", "a-", "Finance", "a_b", "a.b", "a".repeat(33), "ä"])("rejects %j", (slug) => {
    expect(teamSlugSchema.safeParse(slug).success).toBe(false);
  });
});

describe("request bodies", () => {
  it("requires slug, name and a team admin to create a team", () => {
    expect(createTeamSchema.safeParse({ slug: "ops", name: "Ops", adminUserId: id }).success).toBe(
      true,
    );
    expect(createTeamSchema.safeParse({ slug: "ops", name: "Ops" }).success).toBe(false);
    expect(createTeamSchema.safeParse({ slug: "ops", name: "  ", adminUserId: id }).success).toBe(
      false,
    );
    expect(
      createTeamSchema.safeParse({ slug: "ops", name: "Ops", adminUserId: id, extra: 1 }).success,
    ).toBe(false);
  });

  it("accepts only the fixed team roles", () => {
    for (const role of ["team_admin", "builder", "member"]) {
      expect(memberRoleSchema.safeParse({ role }).success).toBe(true);
    }
    expect(memberRoleSchema.safeParse({ role: "owner" }).success).toBe(false);
    expect(addMemberSchema.safeParse({ email: "x@y.test", role: "admin" }).success).toBe(false);
  });

  it("never lets a role change name the Owner (ownership moves only by transfer)", () => {
    expect(installRoleChangeSchema.safeParse({ role: "owner" }).success).toBe(false);
    expect(installRoleChangeSchema.safeParse({ role: "admin" }).success).toBe(true);
  });
});
