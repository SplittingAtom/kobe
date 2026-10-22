import { describe, expect, it, vi } from "vitest";
import {
  TEAM_HEADER,
  fetchMyTeams,
  roleLabel,
  setActiveTeam,
  teamToActivate,
  type MyTeams,
} from "./teams";

const team = (
  id: string,
  name: string,
  extra: { registry?: boolean; chatReady?: boolean } = {},
) => ({
  id,
  slug: id,
  name,
  role: "member" as const,
  registry: extra.registry ?? false,
  chatReady: extra.chatReady ?? true,
});
const finance = team("t-fin", "Finance");
const ops = { ...team("t-ops", "Ops"), role: "team_admin" as const };
const registry = team("t-reg", "Skill Registry", { registry: true, chatReady: false });
const idle = team("t-idle", "Idle", { chatReady: false });
const none = (teams: MyTeams["teams"], lastTeamId: string | null = null): MyTeams => ({
  activeTeamId: null,
  lastTeamId,
  teams,
});

function respond(status: number, body: unknown): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

describe("teamToActivate", () => {
  it("keeps the current active team", () => {
    const my = { activeTeamId: ops.id, lastTeamId: finance.id, teams: [finance, ops] };
    expect(teamToActivate(my, finance.id)).toBeNull();
  });

  it("prefers the user's last team the server remembers, when still a member", () => {
    expect(teamToActivate(none([finance, ops], ops.id), finance.id)).toBe(ops.id);
    // Even the Registry team, when that is where the user last worked.
    expect(teamToActivate(none([registry, finance], registry.id), null)).toBe(registry.id);
  });

  it("then the last team this browser used, when still a member", () => {
    expect(teamToActivate(none([finance, ops]), ops.id)).toBe(ops.id);
    expect(teamToActivate(none([finance, ops], "gone"), ops.id)).toBe(ops.id);
  });

  it("skips the Registry team for the first working team (KOBE-456)", () => {
    expect(teamToActivate(none([registry, finance, ops]), null)).toBe(finance.id);
    expect(teamToActivate(none([registry, finance]), "gone")).toBe(finance.id);
  });

  it("prefers a working team where chat can run", () => {
    expect(teamToActivate(none([registry, idle, ops]), null)).toBe(ops.id);
    expect(teamToActivate(none([registry, idle]), null)).toBe(idle.id);
  });

  it("falls back to the first team by name when there is nothing better", () => {
    expect(teamToActivate(none([registry]), null)).toBe(registry.id);
    expect(teamToActivate(none([finance, ops]), null)).toBe(finance.id);
  });

  it("has nothing to activate without teams", () => {
    expect(teamToActivate(none([]), null)).toBeNull();
  });
});

describe("roleLabel", () => {
  it("names the fixed team roles", () => {
    expect([roleLabel("team_admin"), roleLabel("builder"), roleLabel("member")]).toEqual([
      "Team admin",
      "Builder",
      "Member",
    ]);
  });
});

describe("fetchMyTeams", () => {
  it("returns the caller's teams", async () => {
    const body: MyTeams = { activeTeamId: finance.id, lastTeamId: ops.id, teams: [finance] };
    expect(await fetchMyTeams(respond(200, body))).toEqual(body);
  });

  it("reads an answer without the default-team hints as plain working teams", async () => {
    const body = { activeTeamId: null, teams: [{ id: "t", slug: "t", name: "T", role: "member" }] };
    expect(await fetchMyTeams(respond(200, body))).toEqual({
      activeTeamId: null,
      lastTeamId: null,
      teams: [{ id: "t", slug: "t", name: "T", role: "member", registry: false, chatReady: true }],
    });
  });

  it("returns null when signed out", async () => {
    expect(await fetchMyTeams(respond(401, { code: "unauthenticated" }))).toBeNull();
  });

  it("throws on other failures", async () => {
    await expect(fetchMyTeams(respond(500, {}))).rejects.toThrow(/teams/);
  });
});

describe("setActiveTeam", () => {
  it("PUTs the team id as JSON", async () => {
    const fetchFn = respond(200, { activeTeamId: ops.id, role: "team_admin" });
    await setActiveTeam(ops.id, fetchFn);
    expect(fetchFn).toHaveBeenCalledWith("/v1/me/teams/active", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ teamId: ops.id }),
    });
  });

  it("throws when the server refuses", async () => {
    await expect(setActiveTeam(ops.id, respond(403, {}))).rejects.toThrow(/switch/);
  });

  it("exposes the header that pins requests to the active team", () => {
    expect(TEAM_HEADER).toBe("x-kobe-team");
  });
});
