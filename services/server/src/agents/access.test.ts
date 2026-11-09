import { describe, expect, it } from "vitest";
import type { TeamRole } from "@kobe/db";
import {
  agentAccess,
  canCreateAgent,
  canForkAgent,
  forkBinding,
  type AgentRef,
  type ForkVia,
} from "./access.js";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ROLES: readonly TeamRole[] = ["member", "contributor", "team_admin"];

const team = (owner = OTHER): AgentRef => ({ scope: "team", ownerUserId: owner });
const personal = (owner = ME): AgentRef => ({ scope: "personal", ownerUserId: owner });
const gallery: AgentRef = { scope: "gallery", ownerUserId: null };

const access = (role: TeamRole, agent: AgentRef) => agentAccess({ userId: ME, role }, agent);

describe("team agents (D8, D19)", () => {
  it.each(ROLES)("%s sees the summary of every team agent", (role) => {
    expect(access(role, team()).see).toBe(true);
  });

  it("shows the definition and export to builders and team admins only", () => {
    expect(access("member", team()).readDefinition).toBe(false);
    expect(access("contributor", team()).readDefinition).toBe(true);
    expect(access("team_admin", team()).readDefinition).toBe(true);
  });

  it("lets builders edit their own agents and team admins edit any", () => {
    expect(access("member", team(ME)).edit).toBe(false);
    expect(access("contributor", team(ME)).edit).toBe(true);
    expect(access("contributor", team(OTHER)).edit).toBe(false);
    expect(access("team_admin", team(OTHER)).edit).toBe(true);
  });

  it("lets builders publish their own agents and team admins publish any (D8, KOBE-46)", () => {
    expect(access("member", team(ME)).publish).toBe(false);
    expect(access("contributor", team(ME)).publish).toBe(true);
    expect(access("contributor", team(OTHER)).publish).toBe(false);
    expect(access("team_admin", team(OTHER)).publish).toBe(true);
  });

  it("lets only team admins suspend", () => {
    expect(access("contributor", team(ME)).setStatus).toBe(false);
    expect(access("team_admin", team(OTHER)).setStatus).toBe(true);
  });
});

describe("personal agents (D6, D9)", () => {
  it.each(ROLES)("%s fully controls their own personal agents", (role) => {
    expect(access(role, personal())).toEqual({
      see: true,
      readDefinition: true,
      edit: true,
      publish: true,
      setStatus: false,
    });
  });

  it.each(ROLES)("%s cannot even see someone else's personal agent", (role) => {
    expect(access(role, personal(OTHER))).toEqual({
      see: false,
      readDefinition: false,
      edit: false,
      publish: false,
      setStatus: false,
    });
  });
});

describe("gallery agents (D19, D21)", () => {
  it.each(ROLES)("%s reads but never edits gallery agents from a team", (role) => {
    expect(access(role, gallery)).toEqual({
      see: true,
      readDefinition: true,
      edit: false,
      publish: false,
      setStatus: false,
    });
  });
});

describe("creating and forking", () => {
  it("creates team agents from builder up and personal agents for everyone", () => {
    expect(canCreateAgent("member", "team")).toBe(false);
    expect(canCreateAgent("contributor", "team")).toBe(true);
    expect(canCreateAgent("member", "personal")).toBe(true);
  });

  it("forks from where the caller reads the definition (KOBE-568, §5)", () => {
    const fork = (role: TeamRole, via: ForkVia) => canForkAgent({ userId: ME, role }, via);
    for (const role of ROLES) {
      expect(fork(role, "own")).toBe(true);
      expect(fork(role, "gallery")).toBe(true);
      expect(fork(role, "site_entry")).toBe(true);
    }
    expect(fork("member", "team_owned")).toBe(false);
    expect(fork("member", "team_entry")).toBe(false);
    expect(fork("contributor", "team_owned")).toBe(true);
    expect(fork("contributor", "team_entry")).toBe(true);
    expect(fork("team_admin", "team_entry")).toBe(true);
  });

  it("binds forks of team content to the team, keeps a bound source's binding (AR8)", () => {
    const T = "33333333-3333-4333-8333-333333333333";
    const U = "44444444-4444-4444-8444-444444444444";
    expect(forkBinding("team_owned", null, T)).toBe(T);
    expect(forkBinding("team_entry", null, T)).toBe(T);
    expect(forkBinding("site_entry", null, T)).toBeNull();
    expect(forkBinding("gallery", null, T)).toBeNull();
    expect(forkBinding("own", null, T)).toBeNull();
    expect(forkBinding("own", U, T)).toBe(U);
  });
});
