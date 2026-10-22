import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSiteAccess, fetchTeamAccess } from "./access";
import * as gallery from "./site/gallery";
import * as invites from "./site/invites";
import * as isolation from "./site/isolation";
import * as roles from "./site/roles";
import * as settings from "./site/settings";
import * as teams from "./site/teams";
import * as users from "./site/users";
import * as teamAgents from "./team/agents";
import * as teamInvites from "./team/invites";
import * as members from "./team/members";
import { must } from "../../testing/must";

type Call = { url: string; method: string; headers: Headers; body: unknown };

/** Stubs global fetch with a router: "METHOD /path" → [status, body]. Records calls. */
function stubApi(routes: Record<string, [number, unknown?]>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      calls.push({ url, method, headers: new Headers(init.headers), body: init.body });
      const hit = routes[`${method} ${url}`];
      if (!hit) return new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
      const [status, body] = hit;
      return new Response(body === undefined ? null : JSON.stringify(body), { status });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const me = (siteRole: string | null) => ({
  user: { id: "u-1", name: "Ada", email: "a@x.io", twoFactorEnabled: false },
  siteRole,
});

describe("console access", () => {
  it("reads the site role from /v1/me; null is a plain user", async () => {
    stubApi({ "GET /v1/me": [200, me(null)] });
    const res = await fetchSiteAccess();
    expect(res).toMatchObject({ ok: true, data: { console: "site", siteRole: "user" } });
  });

  it("reads team role and permissions from /v1/team", async () => {
    stubApi({
      "GET /v1/me": [200, me("admin")],
      "GET /v1/team": [
        200,
        {
          team: { id: "t-1", slug: "fin", name: "Finance" },
          role: "team_admin",
          permissions: ["team.members.manage"],
        },
      ],
    });
    const res = await fetchTeamAccess();
    expect(res).toEqual({
      ok: true,
      status: 200,
      data: {
        console: "team",
        user: { id: "u-1", name: "Ada", email: "a@x.io" },
        team: { id: "t-1", slug: "fin", name: "Finance" },
        role: "team_admin",
        permissions: ["team.members.manage"],
        // KOBE-476: site admins may set an agent's Dangerous mode.
        siteAdmin: true,
      },
    });
  });

  it("passes on no_active_team", async () => {
    stubApi({
      "GET /v1/me": [200, me(null)],
      "GET /v1/team": [409, { code: "no_active_team", message: "Choose a team first." }],
    });
    expect(await fetchTeamAccess()).toMatchObject({ ok: false, error: { code: "no_active_team" } });
  });
});

describe("site resources call the right routes", () => {
  it.each([
    ["listUsers", () => users.listUsers(), "GET /v1/site/users", { users: [] }],
    [
      "deactivate",
      () => users.setUserActive("u 2", false),
      "POST /v1/site/users/u%202/deactivate",
      {},
    ],
    ["reactivate", () => users.setUserActive("u2", true), "POST /v1/site/users/u2/reactivate", {}],
    ["listInvites", () => invites.listSiteInvites(), "GET /v1/site/invites", { invitations: [] }],
    ["invite", () => invites.createSiteInvite("b@x.io"), "POST /v1/site/invites", {}],
    ["resend", () => invites.resendSiteInvite("i1"), "POST /v1/site/invites/i1/resend", {}],
    ["revoke", () => invites.revokeSiteInvite("i1"), "DELETE /v1/site/invites/i1", undefined],
    ["roles", () => roles.listSiteRoles(), "GET /v1/site/roles", { roles: [] }],
    ["grant", () => roles.setSiteRole("u2", "admin"), "PUT /v1/site/roles/u2", {}],
    ["transfer", () => roles.transferOwnership("u2"), "POST /v1/site/roles/transfer-ownership", {}],
    ["teams", () => teams.listSiteTeams(), "GET /v1/site/teams", { teams: [] }],
    [
      "createTeam",
      () => teams.createTeam({ slug: "fin", name: "Finance", adminUserId: "u2" }),
      "POST /v1/site/teams",
      { team: {} },
    ],
    ["rename", () => teams.renameTeam("t1", "Fin"), "PATCH /v1/site/teams/t1", { team: {} }],
    ["roster", () => teams.teamRoster("t1"), "GET /v1/site/teams/t1/members", { members: [] }],
    ["settings", () => settings.getSiteSettings(), "GET /v1/site/settings", {}],
    [
      "putSettings",
      () => settings.putSiteSettings({ requireTwoFactor: true }),
      "PUT /v1/site/settings",
      {},
    ],
    ["isolation", () => isolation.getIsolation(), "GET /v1/site/isolation", {}],
    ["recheck", () => isolation.recheckIsolation(), "POST /v1/site/isolation/check", {}],
    ["gallery", () => gallery.listGalleryAgents(), "GET /v1/site/gallery/agents", { agents: [] }],
  ] as const)("%s", async (_name, call, route, body) => {
    const calls = stubApi({ [route]: [200, body] });
    const res = await call();
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(`${must(calls[0]).method} ${must(calls[0]).url}`).toBe(route);
    // Site routes are not team-scoped: no team header.
    expect(must(calls[0]).headers.has("x-kobe-team")).toBe(false);
  });

  it("sends wire bodies the server's strict schemas accept", async () => {
    const calls = stubApi({
      "POST /v1/site/teams": [201, { team: { id: "t", slug: "fin", name: "Finance" } }],
      "PUT /v1/site/roles/u2": [200, {}],
    });
    await teams.createTeam({ slug: "fin", name: "Finance", adminUserId: "u2" });
    await roles.setSiteRole("u2", "user");
    expect(JSON.parse(String(must(calls[0]).body))).toEqual({
      slug: "fin",
      name: "Finance",
      adminUserId: "u2",
    });
    expect(JSON.parse(String(must(calls[1]).body))).toEqual({ role: "user" });
  });

  it("unwraps list envelopes", async () => {
    stubApi({ "GET /v1/site/users": [200, { users: [{ id: "u", deactivated_at: null }] }] });
    expect(await users.listUsers()).toMatchObject({
      ok: true,
      data: [{ id: "u", deactivatedAt: null }],
    });
  });
});

describe("team resources name the active team on every call", () => {
  it.each([
    ["members", () => members.listTeamMembers("t-1"), "GET /v1/team/members", { members: [] }],
    ["role", () => members.setMemberRole("t-1", "u2", "builder"), "PATCH /v1/team/members/u2", {}],
    ["remove", () => members.removeMember("t-1", "u2"), "DELETE /v1/team/members/u2", undefined],
    [
      "invites",
      () => teamInvites.listTeamInvites("t-1"),
      "GET /v1/team/invites",
      { invitations: [] },
    ],
    [
      "invite",
      () => teamInvites.inviteToTeam("t-1", "b@x.io", "member"),
      "POST /v1/team/invites",
      {},
    ],
    [
      "revoke",
      () => teamInvites.revokeTeamInvite("t-1", "i1"),
      "DELETE /v1/team/invites/i1",
      undefined,
    ],
    [
      "agents",
      () => teamAgents.listTeamAgents("t-1"),
      "GET /v1/agents?scope=team&include_archived=true",
      { agents: [] },
    ],
    [
      "suspend",
      () => teamAgents.setTeamAgentStatus("t-1", "a1", "suspended"),
      "PUT /v1/agents/a1/status",
      {},
    ],
  ] as const)("%s", async (_name, call, route, body) => {
    const calls = stubApi({ [route]: [200, body] });
    expect((await call()).ok).toBe(true);
    expect(`${must(calls[0]).method} ${must(calls[0]).url}`).toBe(route);
    expect(must(calls[0]).headers.get("x-kobe-team")).toBe("t-1");
  });
});
