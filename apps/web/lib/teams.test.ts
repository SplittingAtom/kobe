import { describe, expect, it, vi } from "vitest";
import {
  TEAM_HEADER,
  fetchMyTeams,
  roleLabel,
  setActiveTeam,
  teamToActivate,
  type MyTeams,
} from "./teams";

const finance = { id: "t-fin", slug: "finance", name: "Finance", role: "member" as const };
const ops = { id: "t-ops", slug: "ops", name: "Ops", role: "team_admin" as const };

function respond(status: number, body: unknown): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

describe("teamToActivate", () => {
  it("keeps the current active team", () => {
    expect(teamToActivate({ activeTeamId: ops.id, teams: [finance, ops] }, finance.id)).toBeNull();
  });

  it("prefers the last team this browser used, when still a member", () => {
    expect(teamToActivate({ activeTeamId: null, teams: [finance, ops] }, ops.id)).toBe(ops.id);
  });

  it("falls back to the first team", () => {
    expect(teamToActivate({ activeTeamId: null, teams: [finance, ops] }, "gone")).toBe(finance.id);
    expect(teamToActivate({ activeTeamId: null, teams: [finance, ops] }, null)).toBe(finance.id);
  });

  it("has nothing to activate without teams", () => {
    expect(teamToActivate({ activeTeamId: null, teams: [] }, null)).toBeNull();
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
    const body: MyTeams = { activeTeamId: finance.id, teams: [finance] };
    expect(await fetchMyTeams(respond(200, body))).toEqual(body);
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
