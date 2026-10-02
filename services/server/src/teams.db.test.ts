import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, testServerUrl, type TestDatabase } from "@kobe/db/testing";
import { createApp } from "./app.js";
import { createServerDeps, type ServerDeps } from "./deps.js";
import { TestBrowser } from "./testing/browser.js";

// Own throwaway database: this file needs an Owner, which the first-run tests must not see.
const PUBLIC_URL = "http://kobe.test";
const PASSWORD = "a long enough password";

let database: TestDatabase;
let deps: ServerDeps;
let app: ReturnType<typeof createApp>;
let admin: pg.Pool;

const ids: Record<"owner" | "installAdmin" | "alice" | "bob" | "carol" | "dave", string> = {
  owner: "",
  installAdmin: "",
  alice: "",
  bob: "",
  carol: "",
  dave: "",
};
type Person = keyof typeof ids;
const email = (who: Person) => `${who.toLowerCase()}@teams.test`;

async function signIn(who: Person): Promise<TestBrowser> {
  const b = new TestBrowser(app, PUBLIC_URL);
  const res = await b.post("/api/auth/sign-in/email", { email: email(who), password: PASSWORD });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return b;
}

let as: Record<Person, TestBrowser>;
let finance = "";
let marketing = "";

beforeAll(async () => {
  database = await createTestDatabase(testServerUrl());
  admin = new pg.Pool({ connectionString: database.adminUrl });
  deps = createServerDeps({
    databaseUrl: database.appUrl,
    publicUrl: PUBLIC_URL,
    authSecret: "t".repeat(48),
    setupToken: "setup-token-for-team-tests-0123",
    trustedProxies: ["127.0.0.1/32"],
  });
  app = createApp(deps);
  for (const who of Object.keys(ids) as Person[]) {
    const installRole = who === "owner" ? "owner" : who === "installAdmin" ? "admin" : undefined;
    const user = await deps.createUserWithPassword(
      { email: email(who), name: who, password: PASSWORD },
      installRole ? { installRole } : {},
    );
    ids[who] = user.id;
  }
  as = Object.fromEntries(
    await Promise.all((Object.keys(ids) as Person[]).map(async (w) => [w, await signIn(w)])),
  ) as Record<Person, TestBrowser>;
});

afterAll(async () => {
  await deps?.close();
  await admin?.end();
  await database?.drop();
});

describe("install roles (ac-3)", () => {
  it("lets install admins list roles and refuses plain users", async () => {
    expect((await as.alice.get("/v1/install/roles")).status).toBe(403);
    const res = await as.installAdmin.get("/v1/install/roles");
    expect(res.status).toBe(200);
    expect(res.json.roles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: ids.owner, role: "owner" }),
        expect.objectContaining({ userId: ids.installAdmin, role: "admin" }),
      ]),
    );
  });

  it("lets only the Owner grant and revoke Admin", async () => {
    expect(
      (await as.installAdmin.put(`/v1/install/roles/${ids.dave}`, { role: "admin" })).status,
    ).toBe(403);
    expect((await as.owner.put(`/v1/install/roles/${ids.dave}`, { role: "admin" })).status).toBe(
      200,
    );
    expect((await as.dave.get("/v1/me")).json.installRole).toBe("admin");
    expect((await as.owner.put(`/v1/install/roles/${ids.dave}`, { role: "user" })).status).toBe(
      200,
    );
    expect((await as.dave.get("/v1/me")).json.installRole).toBeNull();
  });

  it("never changes the Owner's role except by transfer", async () => {
    const res = await as.owner.put(`/v1/install/roles/${ids.owner}`, { role: "user" });
    expect(res).toMatchObject({ status: 409, json: { code: "owner_role_fixed" } });
    expect((await as.owner.put(`/v1/install/roles/${ids.owner}`, { role: "owner" })).status).toBe(
      400,
    );
    expect(
      (await as.owner.put(`/v1/install/roles/${randomUUID()}`, { role: "admin" })).status,
    ).toBe(404);
  });

  it("transfers ownership atomically: the old Owner becomes an Admin", async () => {
    const path = "/v1/install/roles/transfer-ownership";
    expect((await as.installAdmin.post(path, { userId: ids.installAdmin })).status).toBe(403);
    expect((await as.owner.post(path, { userId: ids.owner })).status).toBe(400);
    expect((await as.owner.post(path, { userId: randomUUID() })).status).toBe(404);

    expect((await as.owner.post(path, { userId: ids.installAdmin })).status).toBe(200);
    expect((await as.owner.get("/v1/me")).json.installRole).toBe("admin");
    expect((await as.installAdmin.get("/v1/me")).json.installRole).toBe("owner");
    // The former Owner can no longer transfer; the new one hands it back.
    expect((await as.owner.post(path, { userId: ids.owner })).status).toBe(403);
    expect((await as.installAdmin.post(path, { userId: ids.owner })).status).toBe(200);
    const { rows } = await admin.query(`SELECT user_id, role FROM install_roles ORDER BY role`);
    expect(rows).toEqual([
      { user_id: ids.owner, role: "owner" },
      { user_id: ids.installAdmin, role: "admin" },
    ]);
  });
});

describe("teams (ac-1)", () => {
  it("refuses team creation to plain users", async () => {
    const res = await as.alice.post("/v1/install/teams", {
      slug: "rogue",
      name: "Rogue",
      adminUserId: ids.alice,
    });
    expect(res.status).toBe(403);
    expect((await as.alice.get("/v1/install/teams")).status).toBe(403);
  });

  it("creates a team with its first team admin", async () => {
    const res = await as.installAdmin.post("/v1/install/teams", {
      slug: "finance",
      name: "Finance",
      adminUserId: ids.alice,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    finance = res.json.team.id;
    expect(res.json.team).toMatchObject({ slug: "finance", name: "Finance" });
    const members = await as.installAdmin.get(`/v1/install/teams/${finance}/members`);
    expect(members.json.members).toEqual([
      expect.objectContaining({ userId: ids.alice, role: "team_admin", email: email("alice") }),
    ]);

    const second = await as.owner.post("/v1/install/teams", {
      slug: "marketing",
      name: "Marketing",
      adminUserId: ids.bob,
    });
    expect(second.status).toBe(201);
    marketing = second.json.team.id;
  });

  it("validates input and leaves no team behind on failure", async () => {
    const bad = (body: object) => as.installAdmin.post("/v1/install/teams", body);
    expect((await bad({ slug: "Bad Slug", name: "X", adminUserId: ids.alice })).status).toBe(400);
    expect((await bad({ slug: "x".repeat(33), name: "X", adminUserId: ids.alice })).status).toBe(
      400,
    );
    expect(await bad({ slug: "finance", name: "Dup", adminUserId: ids.alice })).toMatchObject({
      status: 409,
      json: { code: "slug_taken" },
    });
    expect(await bad({ slug: "ghost", name: "Ghost", adminUserId: randomUUID() })).toMatchObject({
      status: 404,
      json: { code: "user_not_found" },
    });
    const { rows } = await admin.query(`SELECT slug FROM teams ORDER BY slug`);
    expect(rows.map((r) => r.slug)).toEqual(["finance", "marketing"]);
  });

  it("lists and renames teams; the slug never changes", async () => {
    const renamed = await as.installAdmin.patch(`/v1/install/teams/${finance}`, {
      name: "Finance & Ops",
    });
    expect(renamed.json.team).toEqual({ id: finance, slug: "finance", name: "Finance & Ops" });
    expect(
      (await as.installAdmin.patch(`/v1/install/teams/${finance}`, { slug: "x" })).status,
    ).toBe(400);
    expect(
      (await as.installAdmin.patch(`/v1/install/teams/${randomUUID()}`, { name: "N" })).status,
    ).toBe(404);
    const list = await as.installAdmin.get("/v1/install/teams");
    expect(list.json.teams.map((t: { slug: string }) => t.slug)).toEqual(["finance", "marketing"]);
  });

  it("lets install admins place users in teams and set their role", async () => {
    const put = (team: string, user: string, role: string) =>
      as.installAdmin.put(`/v1/install/teams/${team}/members/${user}`, { role });
    expect((await put(finance, ids.bob, "member")).status).toBe(201);
    expect((await put(finance, ids.carol, "builder")).status).toBe(201);
    expect((await put(finance, ids.carol, "member")).status).toBe(200);
    expect((await put(randomUUID(), ids.carol, "member")).status).toBe(404);
    expect((await put(finance, randomUUID(), "member")).status).toBe(404);
    expect((await put(finance, ids.carol, "owner")).status).toBe(400);
    expect((await put(marketing, ids.bob, "member")).json.code).toBe("last_team_admin");
  });
});

describe("active team and switcher API (ac-5)", () => {
  it("lists only the caller's teams with their role, and no active team at first", async () => {
    const res = await as.bob.get("/v1/me/teams");
    expect(res.json).toEqual({
      activeTeamId: null,
      teams: [
        { id: finance, slug: "finance", name: "Finance & Ops", role: "member" },
        { id: marketing, slug: "marketing", name: "Marketing", role: "team_admin" },
      ],
    });
    expect((await as.dave.get("/v1/me/teams")).json).toEqual({ activeTeamId: null, teams: [] });
  });

  it("requires an active team for team-scoped routes", async () => {
    expect(await as.bob.get("/v1/team")).toMatchObject({
      status: 409,
      json: { code: "no_active_team" },
    });
  });

  it("only lets members select a team (same answer for unknown teams)", async () => {
    const other = await as.alice.put("/v1/me/teams/active", { teamId: marketing });
    const unknown = await as.alice.put("/v1/me/teams/active", { teamId: randomUUID() });
    expect(other).toMatchObject({ status: 403, json: { code: "not_a_team_member" } });
    expect(unknown.status).toBe(403);
    expect(unknown.json.code).toBe(other.json.code);
    expect((await as.alice.put("/v1/me/teams/active", { teamId: "finance" })).status).toBe(400);
  });

  it("switches teams; every team-scoped request resolves to the active one", async () => {
    expect((await as.bob.put("/v1/me/teams/active", { teamId: finance })).json).toEqual({
      activeTeamId: finance,
      role: "member",
    });
    const inFinance = await as.bob.get("/v1/team");
    expect(inFinance.json).toMatchObject({ team: { id: finance }, role: "member" });
    expect(inFinance.json.permissions).toContain("team.chat");
    expect(inFinance.json.permissions).not.toContain("team.members.manage");

    await as.bob.put("/v1/me/teams/active", { teamId: marketing });
    const inMarketing = await as.bob.get("/v1/team");
    expect(inMarketing.json).toMatchObject({ team: { id: marketing }, role: "team_admin" });
    expect(inMarketing.json.permissions).toContain("team.members.manage");
    expect((await as.bob.get("/v1/me/teams")).json.activeTeamId).toBe(marketing);
  });

  it("keeps the active team per session", async () => {
    const otherDevice = await signIn("bob");
    expect((await otherDevice.get("/v1/me/teams")).json.activeTeamId).toBeNull();
    expect((await as.bob.get("/v1/me/teams")).json.activeTeamId).toBe(marketing);
  });

  it("rejects a request whose X-Kobe-Team names a different team (stale tab)", async () => {
    const stale = await as.bob.get("/v1/team", { "x-kobe-team": finance });
    expect(stale).toMatchObject({
      status: 409,
      json: { code: "team_mismatch", activeTeamId: marketing },
    });
    expect((await as.bob.get("/v1/team", { "x-kobe-team": marketing })).status).toBe(200);
    expect((await as.bob.get("/v1/team", { "x-kobe-team": "nope" })).status).toBe(400);
  });

  it("cannot be set through Better Auth's update-session endpoint", async () => {
    const before = await admin.query(`SELECT count(*)::int AS n FROM session_active_teams`);
    const res = await as.alice.post("/api/auth/update-session", {
      teamId: marketing,
      activeTeamId: marketing,
    });
    expect(res.status).not.toBe(200);
    const after = await admin.query(`SELECT count(*)::int AS n FROM session_active_teams`);
    expect(after.rows).toEqual(before.rows);
    expect(await as.alice.get("/v1/team")).toMatchObject({ status: 409 });
  });

  it("drops the active team with the session on sign-out", async () => {
    const b = await signIn("carol");
    await b.put("/v1/me/teams/active", { teamId: finance });
    expect((await b.post("/api/auth/sign-out")).status).toBe(200);
    const { rows } = await admin.query(
      `SELECT count(*)::int AS n FROM session_active_teams s
       LEFT JOIN sessions x ON x.id = s.session_id WHERE x.id IS NULL`,
    );
    expect(rows[0]).toEqual({ n: 0 });
  });
});

describe("team membership via /v1/team (ac-2, ac-4)", () => {
  beforeAll(async () => {
    await as.alice.put("/v1/me/teams/active", { teamId: finance });
    await as.bob.put("/v1/me/teams/active", { teamId: finance });
    await as.carol.put("/v1/me/teams/active", { teamId: finance });
  });

  it("lets members read the roster but not change it", async () => {
    const roster = await as.bob.get("/v1/team/members");
    expect(roster.status).toBe(200);
    expect(
      roster.json.members.map((m: { userId: string; role: string }) => [m.userId, m.role]),
    ).toEqual([
      [ids.alice, "team_admin"],
      [ids.bob, "member"],
      [ids.carol, "member"],
    ]);
    expect(
      (await as.bob.post("/v1/team/members", { email: email("dave"), role: "member" })).status,
    ).toBe(403);
    expect((await as.bob.patch(`/v1/team/members/${ids.carol}`, { role: "builder" })).status).toBe(
      403,
    );
    expect((await as.bob.delete(`/v1/team/members/${ids.carol}`)).status).toBe(403);
  });

  it("lets the team admin add, re-role and remove members", async () => {
    const add = await as.alice.post("/v1/team/members", {
      email: "DAVE@teams.test",
      role: "builder",
    });
    expect(add).toMatchObject({ status: 201, json: { userId: ids.dave, role: "builder" } });
    expect(
      (await as.alice.post("/v1/team/members", { email: email("dave"), role: "member" })).json.code,
    ).toBe("already_member");
    expect(
      (await as.alice.post("/v1/team/members", { email: "nobody@teams.test", role: "member" }))
        .status,
    ).toBe(404);
    expect(
      (await as.alice.post("/v1/team/members", { email: email("dave"), role: "boss" })).status,
    ).toBe(400);

    expect(
      (await as.alice.patch(`/v1/team/members/${ids.carol}`, { role: "builder" })).status,
    ).toBe(200);
    expect((await as.carol.get("/v1/team")).json.role).toBe("builder");
    expect(
      (await as.alice.patch(`/v1/team/members/${randomUUID()}`, { role: "member" })).status,
    ).toBe(404);
  });

  it("never leaves a team without a team admin", async () => {
    expect(
      (await as.alice.patch(`/v1/team/members/${ids.alice}`, { role: "member" })).json.code,
    ).toBe("last_team_admin");
    expect((await as.alice.delete(`/v1/team/members/${ids.alice}`)).json.code).toBe(
      "last_team_admin",
    );
    expect(
      (await as.installAdmin.delete(`/v1/install/teams/${finance}/members/${ids.alice}`)).json.code,
    ).toBe("last_team_admin");
  });

  it("keeps one team admin when two admins demote themselves concurrently", async () => {
    expect(
      (await as.alice.patch(`/v1/team/members/${ids.bob}`, { role: "team_admin" })).status,
    ).toBe(200);
    const results = await Promise.all([
      as.alice.patch(`/v1/team/members/${ids.alice}`, { role: "member" }),
      as.bob.patch(`/v1/team/members/${ids.bob}`, { role: "member" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const { rows } = await admin.query(
      `SELECT count(*)::int AS n FROM team_members WHERE team_id = $1 AND role = 'team_admin'`,
      [finance],
    );
    expect(rows[0]).toEqual({ n: 1 });
    // Restore Alice as the only team admin, Bob as a member.
    const aliceDemoted = results[0]?.status === 200;
    if (aliceDemoted) await as.bob.patch(`/v1/team/members/${ids.alice}`, { role: "team_admin" });
    await as.alice.patch(`/v1/team/members/${ids.bob}`, { role: "member" });
    expect((await as.alice.get("/v1/team")).json.role).toBe("team_admin");
  });

  it("revokes access on the next request after removal", async () => {
    expect((await as.carol.get("/v1/team")).status).toBe(200);
    expect((await as.alice.delete(`/v1/team/members/${ids.carol}`)).status).toBe(204);
    expect(await as.carol.get("/v1/team")).toMatchObject({
      status: 403,
      json: { code: "not_a_team_member" },
    });
    expect((await as.carol.get("/v1/me/teams")).json).toEqual({ activeTeamId: null, teams: [] });
    expect((await as.alice.delete(`/v1/team/members/${ids.carol}`)).status).toBe(404);
  });

  it("stores memberships under the right team only", async () => {
    const { rows } = await admin.query(
      `SELECT t.slug, m.user_id, m.role FROM team_members m JOIN teams t ON t.id = m.team_id
       ORDER BY t.slug, m.role, m.user_id`,
    );
    const expected = [
      { slug: "finance", user_id: ids.alice, role: "team_admin" },
      { slug: "finance", user_id: ids.bob, role: "member" },
      { slug: "finance", user_id: ids.dave, role: "builder" },
      { slug: "marketing", user_id: ids.bob, role: "team_admin" },
    ];
    expect(rows).toHaveLength(expected.length);
    expect(rows).toEqual(expect.arrayContaining(expected));
  });
});

describe("install admins and team content (ac-4)", () => {
  it("gives install roles no team access: they can't select or use a team they're not in", async () => {
    for (const who of ["owner", "installAdmin"] as const) {
      expect((await as[who].get("/v1/me/teams")).json.teams).toEqual([]);
      expect((await as[who].put("/v1/me/teams/active", { teamId: finance })).status).toBe(403);
      expect((await as[who].get("/v1/team/members")).status).toBe(409);
    }
  });

  it("keeps a removed member out even with a stale active-team pointer", async () => {
    // Plant a pointer directly (as if set before removal) and check every request re-verifies.
    const [sessionRow] = (
      await admin.query(`SELECT id FROM sessions WHERE user_id = $1 LIMIT 1`, [ids.installAdmin])
    ).rows;
    await admin.query(
      `INSERT INTO session_active_teams (session_id, team_id) VALUES ($1, $2)
       ON CONFLICT (session_id) DO UPDATE SET team_id = EXCLUDED.team_id`,
      [sessionRow.id, finance],
    );
    const sessions = await admin.query(
      `SELECT count(*)::int AS n FROM sessions WHERE user_id = $1`,
      [ids.installAdmin],
    );
    expect(sessions.rows[0]).toEqual({ n: 1 });
    expect(await as.installAdmin.get("/v1/team/members")).toMatchObject({
      status: 403,
      json: { code: "not_a_team_member" },
    });
  });
});
