import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchInstallAccess, fetchTeamAccess } from "./access";
import * as gallery from "./install/gallery";
import * as invites from "./install/invites";
import * as isolation from "./install/isolation";
import * as roles from "./install/roles";
import * as settings from "./install/settings";
import * as teams from "./install/teams";
import * as users from "./install/users";
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

const me = (installRole: string | null) => ({
  user: { id: "u-1", name: "Ada", email: "a@x.io", twoFactorEnabled: false },
  installRole,
});

describe("console access", () => {
  it("reads the install role from /v1/me; null is a plain user", async () => {
    stubApi({ "GET /v1/me": [200, me(null)] });
    const res = await fetchInstallAccess();
    expect(res).toMatchObject({ ok: true, data: { console: "install", installRole: "user" } });
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

describe("install resources call the right routes", () => {
  it.each([
    ["listUsers", () => users.listUsers(), "GET /v1/install/users", { users: [] }],
    [
      "deactivate",
      () => users.setUserActive("u 2", false),
      "POST /v1/install/users/u%202/deactivate",
      {},
    ],
    [
      "reactivate",
      () => users.setUserActive("u2", true),
      "POST /v1/install/users/u2/reactivate",
      {},
    ],
    [
      "listInvites",
      () => invites.listInstallInvites(),
      "GET /v1/install/invites",
      { invitations: [] },
    ],
    ["invite", () => invites.createInstallInvite("b@x.io"), "POST /v1/install/invites", {}],
    ["resend", () => invites.resendInstallInvite("i1"), "POST /v1/install/invites/i1/resend", {}],
    ["revoke", () => invites.revokeInstallInvite("i1"), "DELETE /v1/install/invites/i1", undefined],
    ["roles", () => roles.listInstallRoles(), "GET /v1/install/roles", { roles: [] }],
    ["grant", () => roles.setInstallRole("u2", "admin"), "PUT /v1/install/roles/u2", {}],
    [
      "transfer",
      () => roles.transferOwnership("u2"),
      "POST /v1/install/roles/transfer-ownership",
      {},
    ],
    ["teams", () => teams.listInstallTeams(), "GET /v1/install/teams", { teams: [] }],
    [
      "createTeam",
      () => teams.createTeam({ slug: "fin", name: "Finance", adminUserId: "u2" }),
      "POST /v1/install/teams",
      { team: {} },
    ],
    ["rename", () => teams.renameTeam("t1", "Fin"), "PATCH /v1/install/teams/t1", { team: {} }],
    ["roster", () => teams.teamRoster("t1"), "GET /v1/install/teams/t1/members", { members: [] }],
    ["settings", () => settings.getInstallSettings(), "GET /v1/install/settings", {}],
    [
      "putSettings",
      () => settings.putInstallSettings({ requireTwoFactor: true }),
      "PUT /v1/install/settings",
      {},
    ],
    ["isolation", () => isolation.getIsolation(), "GET /v1/install/isolation", {}],
    ["recheck", () => isolation.recheckIsolation(), "POST /v1/install/isolation/check", {}],
    [
      "gallery",
      () => gallery.listGalleryAgents(),
      "GET /v1/install/gallery/agents",
      { agents: [] },
    ],
  ] as const)("%s", async (_name, call, route, body) => {
    const calls = stubApi({ [route]: [200, body] });
    const res = await call();
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(`${must(calls[0]).method} ${must(calls[0]).url}`).toBe(route);
    // Install routes are not team-scoped: no team header.
    expect(must(calls[0]).headers.has("x-kobe-team")).toBe(false);
  });

  it("sends wire bodies the server's strict schemas accept", async () => {
    const calls = stubApi({
      "POST /v1/install/teams": [201, { team: { id: "t", slug: "fin", name: "Finance" } }],
      "PUT /v1/install/roles/u2": [200, {}],
    });
    await teams.createTeam({ slug: "fin", name: "Finance", adminUserId: "u2" });
    await roles.setInstallRole("u2", "user");
    expect(JSON.parse(String(must(calls[0]).body))).toEqual({
      slug: "fin",
      name: "Finance",
      adminUserId: "u2",
    });
    expect(JSON.parse(String(must(calls[1]).body))).toEqual({ role: "user" });
  });

  it("unwraps list envelopes", async () => {
    stubApi({ "GET /v1/install/users": [200, { users: [{ id: "u", deactivated_at: null }] }] });
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
