import { describe, expect, it } from "vitest";
import type { TeamRole } from "@kobe/db";
import { agentAccess, canCreateAgent, canForkAgent, type AgentRef } from "./access.js";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ROLES: readonly TeamRole[] = ["member", "builder", "team_admin"];

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
    expect(access("builder", team()).readDefinition).toBe(true);
    expect(access("team_admin", team()).readDefinition).toBe(true);
  });

  it("lets builders edit their own agents and team admins edit any", () => {
    expect(access("member", team(ME)).edit).toBe(false);
    expect(access("builder", team(ME)).edit).toBe(true);
    expect(access("builder", team(OTHER)).edit).toBe(false);
    expect(access("team_admin", team(OTHER)).edit).toBe(true);
  });

  it("lets builders publish their own agents and team admins publish any (D8, KOBE-46)", () => {
    expect(access("member", team(ME)).publish).toBe(false);
    expect(access("builder", team(ME)).publish).toBe(true);
    expect(access("builder", team(OTHER)).publish).toBe(false);
    expect(access("team_admin", team(OTHER)).publish).toBe(true);
  });

  it("lets only team admins suspend", () => {
    expect(access("builder", team(ME)).setStatus).toBe(false);
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
    expect(canCreateAgent("builder", "team")).toBe(true);
    expect(canCreateAgent("member", "personal")).toBe(true);
  });

  it("forks gallery agents into the team (builders) or personal scope (anyone)", () => {
    expect(canForkAgent({ userId: ME, role: "member" }, gallery, "personal")).toBe(true);
    expect(canForkAgent({ userId: ME, role: "member" }, gallery, "team")).toBe(false);
    expect(canForkAgent({ userId: ME, role: "builder" }, gallery, "team")).toBe(true);
  });

  it("brings a personal agent into the team, but never copies team content out to personal", () => {
    expect(canForkAgent({ userId: ME, role: "builder" }, personal(), "team")).toBe(true);
    expect(canForkAgent({ userId: ME, role: "builder" }, team(), "team")).toBe(true);
    expect(canForkAgent({ userId: ME, role: "team_admin" }, team(ME), "personal")).toBe(false);
    expect(canForkAgent({ userId: ME, role: "member" }, team(), "team")).toBe(false);
    expect(canForkAgent({ userId: ME, role: "builder" }, personal(OTHER), "team")).toBe(false);
  });
});
