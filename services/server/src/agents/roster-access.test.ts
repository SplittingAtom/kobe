import { describe, expect, it } from "vitest";
import type { TeamRole } from "@kobe/db";
import {
  assignDecision,
  rosterActions,
  rosterAdmin,
  type RosterActor,
  type RosterSubject,
} from "./access.js";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const TEAM = "33333333-3333-4333-8333-333333333333";
const ELSEWHERE = "44444444-4444-4444-8444-444444444444";

const actor = (role: TeamRole, siteAdmin = false): RosterActor => ({
  userId: ME,
  role,
  teamId: TEAM,
  siteAdmin,
});

const subject = (over: Partial<RosterSubject> = {}): RosterSubject => ({
  kind: "personal",
  ownerUserId: ME,
  boundTeamId: null,
  published: true,
  archived: false,
  suspended: false,
  teamEntry: null,
  siteEntry: null,
  suspendedHere: false,
  ...over,
});

describe("assigning (AR6)", () => {
  it("builders and team admins assign their own agent to the team; members propose", () => {
    expect(assignDecision(actor("builder"), subject(), "team")).toEqual({
      ok: true,
      mode: "direct",
    });
    expect(assignDecision(actor("team_admin"), subject(), "team")).toEqual({
      ok: true,
      mode: "direct",
    });
    expect(assignDecision(actor("member"), subject(), "team")).toEqual({
      ok: true,
      mode: "propose",
    });
  });

  it("site admins assign to the site; others propose published agents only", () => {
    expect(assignDecision(actor("member", true), subject({ published: false }), "site")).toEqual({
      ok: true,
      mode: "direct",
    });
    expect(assignDecision(actor("team_admin"), subject(), "site")).toEqual({
      ok: true,
      mode: "propose",
    });
    expect(assignDecision(actor("builder"), subject({ published: false }), "site")).toEqual({
      ok: false,
      error: "agent_not_published",
    });
  });

  it("refuses a bound agent outside its team (AR8)", () => {
    const bound = subject({ boundTeamId: ELSEWHERE });
    expect(assignDecision(actor("builder"), bound, "team")).toEqual({
      ok: false,
      error: "agent_bound_to_team",
    });
    expect(assignDecision(actor("builder", true), subject({ boundTeamId: TEAM }), "site")).toEqual({
      ok: false,
      error: "agent_bound_to_team",
    });
    expect(assignDecision(actor("builder"), subject({ boundTeamId: TEAM }), "team")).toEqual({
      ok: true,
      mode: "direct",
    });
  });

  it("refuses someone else's agent, team content, archived agents and live entries", () => {
    expect(assignDecision(actor("team_admin"), subject({ ownerUserId: OTHER }), "team")).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(
      assignDecision(actor("team_admin", true), subject({ kind: "team_owned" }), "site"),
    ).toEqual({ ok: false, error: "forbidden" });
    expect(assignDecision(actor("builder"), subject({ archived: true }), "team")).toEqual({
      ok: false,
      error: "agent_archived",
    });
    expect(assignDecision(actor("builder"), subject({ teamEntry: "proposed" }), "team")).toEqual({
      ok: false,
      error: "already_on_roster",
    });
    // A removed entry can be re-assigned (AR7).
    expect(assignDecision(actor("builder"), subject({ teamEntry: "removed" }), "team").ok).toBe(
      true,
    );
  });

  it("lets a builder put someone else's site-assigned agent on the team roster (§5)", () => {
    const siteAssigned = subject({ ownerUserId: OTHER, siteEntry: "active" });
    expect(assignDecision(actor("builder"), siteAssigned, "team")).toEqual({
      ok: true,
      mode: "direct",
    });
    expect(assignDecision(actor("member"), siteAssigned, "team")).toEqual({
      ok: false,
      error: "forbidden",
    });
  });
});

describe("roster admins", () => {
  it("team admins run the team roster, site admins the site roster", () => {
    expect(rosterAdmin(actor("team_admin"), "team")).toBe(true);
    expect(rosterAdmin(actor("builder"), "team")).toBe(false);
    expect(rosterAdmin(actor("builder", true), "team")).toBe(false);
    expect(rosterAdmin(actor("member", true), "site")).toBe(true);
    expect(rosterAdmin(actor("team_admin"), "site")).toBe(false);
  });
});

describe("row actions per role (§5)", () => {
  const ROLES: readonly TeamRole[] = ["member", "builder", "team_admin"];

  it("own personal agent on the Personal tab: owner edits, forks, assigns or proposes", () => {
    const member = rosterActions(actor("member"), subject(), "personal");
    expect(member).toMatchObject({
      view: true,
      viewDefinition: true,
      edit: true,
      fork: true,
      assignTeam: "propose",
      assignSite: "propose",
      decide: false,
      remove: false,
      suspendHere: false,
    });
    expect(rosterActions(actor("builder", true), subject(), "personal")).toMatchObject({
      assignTeam: "direct",
      assignSite: "direct",
    });
    const proposed = rosterActions(actor("member"), subject({ teamEntry: "proposed" }), "personal");
    expect(proposed).toMatchObject({ assignTeam: null, withdrawTeam: true, withdrawSite: false });
  });

  it.each(ROLES)("team-assigned personal agent of someone else, as %s", (role) => {
    const row = subject({ ownerUserId: OTHER, teamEntry: "active" });
    const a = rosterActions(actor(role), row, "team");
    const admin = role === "team_admin";
    expect(a).toMatchObject({
      view: true,
      viewDefinition: role !== "member",
      edit: false,
      fork: role !== "member",
      assignTeam: null,
      assignSite: null,
      withdrawTeam: false,
      decide: false,
      remove: admin,
      pin: admin,
      suspendHere: admin,
      resumeHere: false,
    });
  });

  it("proposals are decided by the roster's admins only", () => {
    const row = subject({ ownerUserId: OTHER, teamEntry: "proposed", siteEntry: "proposed" });
    expect(rosterActions(actor("team_admin"), row, "team")).toMatchObject({
      decide: true,
      remove: false,
      pin: false,
    });
    expect(rosterActions(actor("builder"), row, "team").decide).toBe(false);
    expect(rosterActions(actor("team_admin"), row, "site").decide).toBe(false);
    expect(rosterActions(actor("member", true), row, "site").decide).toBe(true);
  });

  it.each(ROLES)("team-owned agent of someone else, as %s", (role) => {
    const row = subject({ kind: "team_owned", ownerUserId: OTHER });
    const a = rosterActions(actor(role), row, "team");
    expect(a).toMatchObject({
      viewDefinition: role !== "member",
      edit: role === "team_admin",
      fork: role !== "member",
      assignTeam: null,
      assignSite: null,
      remove: false,
      pin: false,
      suspendHere: role === "team_admin",
    });
  });

  it.each(ROLES)("site-assigned personal agent of someone else, as %s", (role) => {
    const row = subject({ ownerUserId: OTHER, siteEntry: "active" });
    const a = rosterActions(actor(role), row, "site");
    expect(a).toMatchObject({
      view: true,
      viewDefinition: true,
      edit: false,
      fork: true,
      assignTeam: role === "member" ? null : "direct",
      remove: false,
      suspendHere: role === "team_admin",
      suspendSiteWide: false,
    });
  });

  it("site admins remove, pin and suspend site entries site-wide; resume when suspended", () => {
    const row = subject({ ownerUserId: OTHER, siteEntry: "active" });
    expect(rosterActions(actor("member", true), row, "site")).toMatchObject({
      remove: true,
      pin: true,
      suspendSiteWide: true,
      resumeSiteWide: false,
      suspendHere: false,
    });
    const suspended = subject({ ownerUserId: OTHER, siteEntry: "suspended" });
    expect(rosterActions(actor("member", true), suspended, "site")).toMatchObject({
      suspendSiteWide: false,
      resumeSiteWide: true,
    });
  });

  it.each(ROLES)("gallery agent, as %s: read and fork; site admins edit", (role) => {
    const row = subject({ kind: "gallery", ownerUserId: null, suspendedHere: true });
    expect(rosterActions(actor(role), row, "site")).toMatchObject({
      viewDefinition: true,
      edit: false,
      fork: true,
      assignTeam: null,
      assignSite: null,
      remove: false,
      suspendHere: false,
      resumeHere: role === "team_admin",
    });
    expect(rosterActions(actor(role, true), row, "site").edit).toBe(true);
  });
});
