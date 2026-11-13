import { describe, expect, it } from "vitest";
import type { TeamRole } from "@kobe/db";
import {
  MEMORY_STEWARD_SITE_PERMISSIONS,
  MEMORY_STEWARD_TEAM_PERMISSIONS,
  SITE_PERMISSIONS,
  TEAM_PERMISSIONS,
  SKILL_REVIEW_ACTIONS,
  siteMemoryAllows,
  sitePermissionsFor,
  siteRoleAllows,
  skillReviewAllows,
  teamMemoryAllows,
  teamPermissionsFor,
  teamRoleAllows,
  type SiteRole,
  type SitePermission,
  type SkillReviewAction,
  type TeamPermission,
} from "./permissions.js";

describe("team permission matrix (spec D8)", () => {
  it.each<[TeamPermission, boolean, boolean, boolean]>([
    // permission, member, builder, team_admin
    ["team.read", true, true, true],
    ["team.members.read", true, true, true],
    ["team.chat", true, true, true],
    ["team.personal.create", true, true, true],
    ["team.agents.use", true, true, true],
    ["team.agents.build", false, true, true],
    ["team.agents.publish", false, true, true],
    ["team.skills.publish", false, true, true],
    ["team.projects.create", false, true, true],
    ["team.members.manage", false, false, true],
    ["team.models.manage", false, false, true],
    ["team.budgets.manage", false, false, true],
    ["team.connectors.manage", false, false, true],
    ["team.policy.manage", false, false, true],
    ["team.egress.manage", false, false, true],
    ["team.skills.review", false, false, true],
    ["team.skills.installs.manage", false, false, true],
    ["team.retention.manage", false, false, true],
    ["team.eval.manage", false, false, true],
    ["team.memory.manage", false, false, true],
    ["team.memory.curate", false, false, true],
    ["team.memory.site_proposals.confirm", false, false, true],
    ["team.audit.read", false, false, true],
    ["team.schedules.pause", false, false, true],
    ["team.agents.suspend", false, false, true],
    ["team.agents.manage", false, false, true],
  ])("%s: member=%s builder=%s team_admin=%s", (permission, member, builder, admin) => {
    expect(teamRoleAllows("member", permission)).toBe(member);
    expect(teamRoleAllows("contributor", permission)).toBe(builder);
    expect(teamRoleAllows("team_admin", permission)).toBe(admin);
  });

  it("is hierarchical: each role holds every permission of the roles below it", () => {
    const member = teamPermissionsFor("member");
    const builder = teamPermissionsFor("contributor");
    const admin = teamPermissionsFor("team_admin");
    expect(builder).toEqual(expect.arrayContaining([...member]));
    expect(admin).toEqual(expect.arrayContaining([...builder]));
    expect(admin).toEqual(Object.keys(TEAM_PERMISSIONS).sort());
  });

  it("grants nothing to a non-member", () => {
    expect(teamRoleAllows(null, "team.read")).toBe(false);
    expect(teamPermissionsFor(null)).toEqual([]);
  });
});

describe("site permission matrix (spec D8)", () => {
  it.each<[SitePermission, boolean, boolean, boolean]>([
    // permission, user, admin, owner
    ["site.settings.manage", false, true, true],
    ["site.users.manage", false, true, true],
    ["site.teams.manage", false, true, true],
    ["site.audit.read", false, true, true],
    ["site.usage.read", false, true, true],
    ["site.budgets.manage", false, true, true],
    ["site.skills.catalog.manage", false, true, true],
    ["site.skills.review", false, true, true],
    ["site.grants.manage", false, true, true],
    ["site.memory.curate", false, true, true],
    ["site.memory.policy", false, true, true],
    ["site.memory.site_proposals.decide", false, true, true],
    ["site.break_glass.request", false, true, true],
    ["site.roles.manage", false, false, true],
    ["site.ownership.transfer", false, false, true],
  ])("%s: user=%s admin=%s owner=%s", (permission, user, admin, owner) => {
    expect(siteRoleAllows(null, permission)).toBe(user);
    expect(siteRoleAllows("admin", permission)).toBe(admin);
    expect(siteRoleAllows("owner", permission)).toBe(owner);
  });

  it("gives the Owner everything and plain users nothing", () => {
    expect(sitePermissionsFor("owner")).toEqual(Object.keys(SITE_PERMISSIONS).sort());
    expect(sitePermissionsFor(null)).toEqual([]);
  });

  it("keeps site and team permissions disjoint (site roles never reach team content)", () => {
    const site = Object.keys(SITE_PERMISSIONS);
    expect(site.every((p) => p.startsWith("site."))).toBe(true);
    expect(Object.keys(TEAM_PERMISSIONS).every((p) => p.startsWith("team."))).toBe(true);
  });
});

describe("Skill reviewer grant beside the ladder (KOBE-331, SK22)", () => {
  const reviewer = { siteRole: null, grants: ["skill_reviewer"] } as const;
  const user = { siteRole: null, grants: [] } as const;
  const admin = { siteRole: "admin", grants: [] } as const;
  const owner = { siteRole: "owner", grants: [] } as const;

  /** Exhaustive: a new action fails to compile until it is placed here (review L5). */
  const REVIEWER_MAY = {
    "queue.read": true,
    claim: true,
    comment: true,
    rerun: true,
    approve: true,
    request_changes: true,
    reject: true,
    reject_and_block: false,
    withdraw: false,
    revoke: false,
    tag_default: false,
    settings: false,
  } as const satisfies Record<SkillReviewAction, boolean>;

  it.each(Object.entries(REVIEWER_MAY) as [SkillReviewAction, boolean][])(
    "%s: reviewer=%s, Site admins and the Owner always, users never",
    (action, mayReview) => {
      expect(skillReviewAllows(reviewer, action)).toBe(mayReview);
      expect(skillReviewAllows(admin, action)).toBe(true);
      expect(skillReviewAllows(owner, action)).toBe(true);
      expect(skillReviewAllows(user, action)).toBe(false);
    },
  );

  it("covers every review action in the matrix", () => {
    expect([...SKILL_REVIEW_ACTIONS].sort()).toEqual(
      [
        "approve",
        "claim",
        "comment",
        "queue.read",
        "rerun",
        "reject",
        "reject_and_block",
        "request_changes",
        "revoke",
        "settings",
        "tag_default",
        "withdraw",
      ].sort(),
    );
  });

  it("leaves the site role ladder unchanged: the grant adds no site permission (ac-3)", () => {
    expect(sitePermissionsFor(null)).toEqual([]);
    expect(siteRoleAllows(null, "site.skills.review")).toBe(false);
    expect(sitePermissionsFor("admin")).not.toContain("site.roles.manage");
  });
});

describe("memory stewards beside the ladders (KOBE-380, SM19)", () => {
  const TEAM_ROLES: readonly (TeamRole | null)[] = [null, "member", "contributor", "team_admin"];
  const SITE_ROLES: readonly SiteRole[] = [null, "admin", "owner"];

  /** Who may curate Workspace memory: Team admins, and stewards of any role; never a non-member. */
  it.each(TEAM_ROLES.flatMap((role) => [false, true].map((steward) => [role, steward] as const)))(
    "team.memory.curate: role=%s steward=%s",
    (role, steward) => {
      const expected = role === "team_admin" || (role !== null && steward);
      expect(teamMemoryAllows({ role, memorySteward: steward }, "team.memory.curate")).toBe(
        expected,
      );
    },
  );

  it("gives a Contributor no memory rights from the role (ac-1)", () => {
    const perms = teamPermissionsFor("contributor");
    expect(perms.filter((p) => p.startsWith("team.memory."))).toEqual([]);
    expect(teamPermissionsFor("member").filter((p) => p.startsWith("team.memory."))).toEqual([]);
  });

  it("adds exactly team.memory.curate to a Workspace steward of any role (ac-3)", () => {
    expect(MEMORY_STEWARD_TEAM_PERMISSIONS).toEqual(["team.memory.curate"]);
    for (const role of ["member", "contributor"] as const) {
      const steward = teamPermissionsFor(role, { memorySteward: true });
      expect(steward).toEqual([...teamPermissionsFor(role), "team.memory.curate"].sort());
    }
    expect(teamPermissionsFor("team_admin", { memorySteward: true })).toEqual(
      teamPermissionsFor("team_admin"),
    );
    expect(teamPermissionsFor(null, { memorySteward: true })).toEqual([]);
  });

  it("never lets a Workspace steward confirm a Site proposal or manage memory switches (ac-3)", () => {
    for (const role of ["member", "contributor"] as const) {
      const who = { role, memorySteward: true };
      expect(teamMemoryAllows(who, "team.memory.site_proposals.confirm")).toBe(false);
      expect(teamMemoryAllows(who, "team.memory.manage")).toBe(false);
      expect(teamMemoryAllows(who, "team.members.manage")).toBe(false);
      expect(teamMemoryAllows(who, "team.policy.manage")).toBe(false);
    }
  });

  /** Exhaustive over site permissions: a Site steward curates and decides Site proposals only. */
  it.each(Object.keys(SITE_PERMISSIONS) as SitePermission[])(
    "%s: a plain user with the memory_steward grant",
    (permission) => {
      const steward = { siteRole: null, grants: ["memory_steward"] } as const;
      expect(siteMemoryAllows(steward, permission)).toBe(
        permission === "site.memory.curate" || permission === "site.memory.site_proposals.decide",
      );
    },
  );

  it("lets Site admins and the Owner do every memory action, users none (ac-1)", () => {
    for (const permission of [
      "site.memory.curate",
      "site.memory.policy",
      "site.memory.site_proposals.decide",
    ] as const) {
      for (const siteRole of SITE_ROLES) {
        const who = { siteRole, grants: [] };
        expect(siteMemoryAllows(who, permission)).toBe(siteRole !== null);
      }
    }
  });

  it("lets a Site steward accept or dismiss Site proposals but never set Policy (ac-3)", () => {
    expect(MEMORY_STEWARD_SITE_PERMISSIONS).toEqual([
      "site.memory.curate",
      "site.memory.site_proposals.decide",
    ]);
    const steward = { siteRole: null, grants: ["memory_steward"] } as const;
    expect(siteMemoryAllows(steward, "site.memory.policy")).toBe(false);
    expect(siteMemoryAllows(steward, "site.memory.site_proposals.decide")).toBe(true);
    expect(sitePermissionsFor(null)).toEqual([]);
  });

  it("does not mix the grants: a Skill reviewer is no steward, a steward no reviewer", () => {
    const reviewer = { siteRole: null, grants: ["skill_reviewer"] } as const;
    expect(siteMemoryAllows(reviewer, "site.memory.curate")).toBe(false);
    const steward = { siteRole: null, grants: ["memory_steward"] } as const;
    for (const action of SKILL_REVIEW_ACTIONS)
      expect(skillReviewAllows(steward, action)).toBe(false);
  });
});
