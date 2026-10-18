import { describe, expect, it } from "vitest";
import {
  SITE_PERMISSIONS,
  TEAM_PERMISSIONS,
  sitePermissionsFor,
  siteRoleAllows,
  teamPermissionsFor,
  teamRoleAllows,
  type SitePermission,
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
    ["team.audit.read", false, false, true],
    ["team.schedules.pause", false, false, true],
    ["team.agents.suspend", false, false, true],
    ["team.agents.manage", false, false, true],
  ])("%s: member=%s builder=%s team_admin=%s", (permission, member, builder, admin) => {
    expect(teamRoleAllows("member", permission)).toBe(member);
    expect(teamRoleAllows("builder", permission)).toBe(builder);
    expect(teamRoleAllows("team_admin", permission)).toBe(admin);
  });

  it("is hierarchical: each role holds every permission of the roles below it", () => {
    const member = teamPermissionsFor("member");
    const builder = teamPermissionsFor("builder");
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
