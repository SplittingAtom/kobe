import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchInstallAccess, fetchTeamAccess } from "./access";
import * as install from "./install";
import * as team from "./team";
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
    ["listUsers", () => install.listUsers(), "GET /v1/install/users", { users: [] }],
    [
      "deactivate",
      () => install.setUserActive("u 2", false),
      "POST /v1/install/users/u%202/deactivate",
      {},
    ],
    [
      "reactivate",
      () => install.setUserActive("u2", true),
      "POST /v1/install/users/u2/reactivate",
      {},
    ],
    [
      "listInvites",
      () => install.listInstallInvites(),
      "GET /v1/install/invites",
      { invitations: [] },
    ],
    ["invite", () => install.createInstallInvite("b@x.io"), "POST /v1/install/invites", {}],
    ["resend", () => install.resendInstallInvite("i1"), "POST /v1/install/invites/i1/resend", {}],
    ["revoke", () => install.revokeInstallInvite("i1"), "DELETE /v1/install/invites/i1", undefined],
    ["roles", () => install.listInstallRoles(), "GET /v1/install/roles", { roles: [] }],
    ["grant", () => install.setInstallRole("u2", "admin"), "PUT /v1/install/roles/u2", {}],
    [
      "transfer",
      () => install.transferOwnership("u2"),
      "POST /v1/install/roles/transfer-ownership",
      {},
    ],
    ["teams", () => install.listInstallTeams(), "GET /v1/install/teams", { teams: [] }],
    [
      "createTeam",
      () => install.createTeam({ slug: "fin", name: "Finance", adminUserId: "u2" }),
      "POST /v1/install/teams",
      { team: {} },
    ],
    ["rename", () => install.renameTeam("t1", "Fin"), "PATCH /v1/install/teams/t1", { team: {} }],
    ["roster", () => install.teamRoster("t1"), "GET /v1/install/teams/t1/members", { members: [] }],
    ["settings", () => install.getInstallSettings(), "GET /v1/install/settings", {}],
    [
      "putSettings",
      () => install.putInstallSettings({ requireTwoFactor: true }),
      "PUT /v1/install/settings",
      {},
    ],
    ["isolation", () => install.getIsolation(), "GET /v1/install/isolation", {}],
    ["recheck", () => install.recheckIsolation(), "POST /v1/install/isolation/check", {}],
    [
      "gallery",
      () => install.listGalleryAgents(),
      "GET /v1/install/gallery/agents",
      { agents: [] },
    ],
    [
      "suspend",
      () => install.setGalleryAgentStatus("a1", "suspended"),
      "PUT /v1/install/gallery/agents/a1/status",
      {},
    ],
    [
      "delete",
      () => install.deleteGalleryAgent("a1"),
      "DELETE /v1/install/gallery/agents/a1",
      undefined,
    ],
    [
      "import",
      () => install.importGalleryAgent("---\nname: X\n---\nhi\n"),
      "POST /v1/install/gallery/agents",
      {},
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
      "POST /v1/install/gallery/agents": [201, {}],
    });
    await install.createTeam({ slug: "fin", name: "Finance", adminUserId: "u2" });
    await install.setInstallRole("u2", "user");
    await install.importGalleryAgent("---\nname: X\n---\n");
    expect(JSON.parse(String(must(calls[0]).body))).toEqual({
      slug: "fin",
      name: "Finance",
      adminUserId: "u2",
    });
    expect(JSON.parse(String(must(calls[1]).body))).toEqual({ role: "user" });
    expect(must(calls[2]).headers.get("content-type")).toMatch(/^text\/markdown/);
  });

  it("unwraps list envelopes", async () => {
    stubApi({ "GET /v1/install/users": [200, { users: [{ id: "u", deactivated_at: null }] }] });
    expect(await install.listUsers()).toMatchObject({
      ok: true,
      data: [{ id: "u", deactivatedAt: null }],
    });
  });
});

describe("team resources name the active team on every call", () => {
  it.each([
    ["members", () => team.listTeamMembers("t-1"), "GET /v1/team/members", { members: [] }],
    ["role", () => team.setMemberRole("t-1", "u2", "builder"), "PATCH /v1/team/members/u2", {}],
    ["remove", () => team.removeMember("t-1", "u2"), "DELETE /v1/team/members/u2", undefined],
    ["invites", () => team.listTeamInvites("t-1"), "GET /v1/team/invites", { invitations: [] }],
    ["invite", () => team.inviteToTeam("t-1", "b@x.io", "member"), "POST /v1/team/invites", {}],
    ["revoke", () => team.revokeTeamInvite("t-1", "i1"), "DELETE /v1/team/invites/i1", undefined],
    ["agents", () => team.listTeamAgents("t-1"), "GET /v1/agents?scope=team", { agents: [] }],
    [
      "suspend",
      () => team.setTeamAgentStatus("t-1", "a1", "suspended"),
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
