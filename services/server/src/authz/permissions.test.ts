import { describe, expect, it } from "vitest";
import {
  INSTALL_PERMISSIONS,
  TEAM_PERMISSIONS,
  installPermissionsFor,
  installRoleAllows,
  teamPermissionsFor,
  teamRoleAllows,
  type InstallPermission,
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
    ["team.retention.manage", false, false, true],
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

describe("install permission matrix (spec D8)", () => {
  it.each<[InstallPermission, boolean, boolean, boolean]>([
    // permission, user, admin, owner
    ["install.settings.manage", false, true, true],
    ["install.users.manage", false, true, true],
    ["install.teams.manage", false, true, true],
    ["install.audit.read", false, true, true],
    ["install.usage.read", false, true, true],
    ["install.budgets.manage", false, true, true],
    ["install.break_glass.request", false, true, true],
    ["install.roles.manage", false, false, true],
    ["install.ownership.transfer", false, false, true],
  ])("%s: user=%s admin=%s owner=%s", (permission, user, admin, owner) => {
    expect(installRoleAllows(null, permission)).toBe(user);
    expect(installRoleAllows("admin", permission)).toBe(admin);
    expect(installRoleAllows("owner", permission)).toBe(owner);
  });

  it("gives the Owner everything and plain users nothing", () => {
    expect(installPermissionsFor("owner")).toEqual(Object.keys(INSTALL_PERMISSIONS).sort());
    expect(installPermissionsFor(null)).toEqual([]);
  });

  it("keeps install and team permissions disjoint (install roles never reach team content)", () => {
    const install = Object.keys(INSTALL_PERMISSIONS);
    expect(install.every((p) => p.startsWith("install."))).toBe(true);
    expect(Object.keys(TEAM_PERMISSIONS).every((p) => p.startsWith("team."))).toBe(true);
  });
});
