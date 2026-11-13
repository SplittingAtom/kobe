import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, testServerUrl, type TestDatabase } from "@kobe/db/testing";
import { createApp } from "./app.js";
import { BackgroundTasks } from "./background.js";
import { createServerDeps, type ServerDeps } from "./deps.js";
import { waitForAppSessionsToClose } from "./testing/app-sessions.js";
import { TestBrowser } from "./testing/browser.js";
import { MemoryMailer } from "./testing/mailer.js";

/**
 * KOBE-638: a Site admin manages a team's members from the Site console (Site console › Teams):
 * add existing users without an invitation (one or several), change roles, remove, Take over a
 * provider-managed row, through the Team console's code paths and rules; never their own
 * membership; every change audited in the team's log with `via: "site_admin"`.
 */
const PUBLIC_URL = "http://kobe.test";
const PASSWORD = "a long enough password";

type Person =
  "owner" | "siteAdmin" | "alice" | "bob" | "carol" | "dave" | "erin" | "gone" | "unv" | "fay";
const PEOPLE: readonly Person[] = [
  "owner",
  "siteAdmin",
  "alice",
  "bob",
  "carol",
  "dave",
  "erin",
  "gone",
  "unv",
  "fay",
];
const ids = {} as Record<Person, string>;
const as = {} as Record<Person, TestBrowser>;
const email = (who: Person) => `${who.toLowerCase()}@site-members.test`;

let database: TestDatabase;
let deps: ServerDeps;
let mailer: MemoryMailer;
let app: ReturnType<typeof createApp>;
let adminPg: pg.Client;
let team = "";
let other = "";

const members = (teamId = team) => `/v1/site/teams/${teamId}/members`;

async function row(who: Person, teamId = team) {
  const { rows } = await adminPg.query<{ role: string; added_via: string | null }>(
    `SELECT role, added_via FROM team_members WHERE team_id = $1 AND user_id = $2`,
    [teamId, ids[who]],
  );
  return rows[0] ?? null;
}

async function lastSeq(): Promise<number> {
  const { rows } = await adminPg.query<{ s: string }>(
    `SELECT coalesce(max(seq), 0) AS s FROM audit_log`,
  );
  return Number(rows[0]?.s ?? 0);
}

async function auditSince(seq: number) {
  const { rows } = await adminPg.query<{
    action: string;
    team_id: string | null;
    actor_id: string | null;
    target: Record<string, unknown>;
  }>(
    `SELECT action, team_id, actor_id, target FROM audit_log WHERE seq > $1 AND action LIKE 'identity.member.%' ORDER BY seq`,
    [seq],
  );
  return rows;
}

/** Alice's (Finance's team admin's) notices of a Site admin's changes, oldest first. */
async function adminNotices(kind: string) {
  const { rows } = await adminPg.query<{
    actor_user_id: string;
    subject_user_id: string;
    team_role: string | null;
  }>(
    `SELECT actor_user_id, subject_user_id, team_role FROM notifications
      WHERE team_id = $1 AND user_id = $2 AND kind = $3 ORDER BY created_at, id`,
    [team, ids.alice, kind],
  );
  return rows;
}

beforeAll(async () => {
  database = await createTestDatabase(testServerUrl());
  adminPg = new pg.Client({ connectionString: database.adminUrl });
  await adminPg.connect();
  const background = new BackgroundTasks();
  mailer = new MemoryMailer(background);
  deps = createServerDeps({
    databaseUrl: database.appUrl,
    publicUrl: PUBLIC_URL,
    authSecret: "m".repeat(48),
    setupToken: "setup-token-for-site-members-01",
    trustedProxies: ["127.0.0.1/32"],
    mailer,
    background,
  });
  app = createApp(deps);
  for (const who of PEOPLE) {
    const siteRole = who === "owner" ? "owner" : who === "siteAdmin" ? "admin" : undefined;
    const user = await deps.createUserWithPassword(
      { email: email(who), name: who, password: PASSWORD },
      siteRole ? { siteRole } : {},
    );
    ids[who] = user.id;
    const b = new TestBrowser(app, PUBLIC_URL);
    const res = await b.post("/api/auth/sign-in/email", { email: email(who), password: PASSWORD });
    expect(res.status).toBe(200);
    as[who] = b;
  }
  for (const [slug, admin] of [
    ["finance", "alice"],
    ["ops", "alice"],
  ] as const) {
    const res = await as.owner.post("/v1/site/teams", {
      slug,
      name: slug,
      adminUserId: ids[admin],
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    if (slug === "finance") team = res.json.team.id;
    else other = res.json.team.id;
  }
  await adminPg.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [ids.gone]);
  // An SSO account whose address the identity provider did not vouch for (review L1).
  await adminPg.query(`UPDATE users SET email_verified = false WHERE id = $1`, [ids.unv]);
});

afterAll(async () => {
  await deps?.close();
  await adminPg?.end();
  if (database) {
    await waitForAppSessionsToClose(database.appRole);
    await database.drop();
  }
});

describe("permission (ac-5)", () => {
  it("refuses plain users and team admins every Site console member route", async () => {
    for (const who of ["alice", "bob"] as const) {
      expect((await as[who].get(`/v1/site/teams/${team}/candidates`)).status).toBe(403);
      expect((await as[who].post(members(), { userIds: [ids.bob], role: "member" })).status).toBe(
        403,
      );
      expect((await as[who].patch(`${members()}/${ids.alice}`, { role: "member" })).status).toBe(
        403,
      );
      expect((await as[who].delete(`${members()}/${ids.alice}`)).status).toBe(403);
    }
    expect(await row("bob")).toBeNull();
  });

  it("refuses a cross-origin write (CSRF)", async () => {
    const res = await as.siteAdmin.request(
      "POST",
      members(),
      { userIds: [ids.bob], role: "member" },
      { origin: "http://evil.test" },
    );
    expect(res.status).toBe(403);
    expect(await row("bob")).toBeNull();
  });
});

describe("candidates (ac-2)", () => {
  it("lists active non-members by name or email, never the caller or a deactivated user", async () => {
    const all = await as.siteAdmin.get(`/v1/site/teams/${team}/candidates`);
    expect(all.status).toBe(200);
    const listed = all.json.candidates.map((c: { userId: string }) => c.userId);
    expect(listed).toEqual(expect.arrayContaining([ids.bob, ids.carol, ids.owner]));
    expect(listed).not.toContain(ids.siteAdmin);
    expect(listed).not.toContain(ids.alice);
    expect(listed).not.toContain(ids.gone);
    const byEmail = await as.siteAdmin.get(`/v1/site/teams/${team}/candidates?q=CAROL@`);
    expect(byEmail.json.candidates).toEqual([
      { userId: ids.carol, name: "carol", email: email("carol") },
    ]);
    const wild = await as.siteAdmin.get(`/v1/site/teams/${team}/candidates?q=%25`);
    expect(wild.json.candidates).toEqual([]);
  });
});

describe("add (ac-2, ac-4)", () => {
  it("adds one user at once: site_admin row, audit as the Site admin, bell and email", async () => {
    const seq = await lastSeq();
    const res = await as.siteAdmin.post(members(), { userIds: [ids.bob], role: "contributor" });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.added).toEqual([{ userId: ids.bob, role: "contributor" }]);
    expect(await row("bob")).toEqual({ role: "contributor", added_via: "site_admin" });
    expect(await auditSince(seq)).toEqual([
      {
        action: "identity.member.added",
        team_id: team,
        actor_id: ids.siteAdmin,
        target: { userId: ids.bob, role: "contributor", via: "site_admin" },
      },
    ]);
    // Bob is in at once: he can select the team and sees the notification there.
    expect((await as.bob.put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
    as.bob.team = team;
    const bell = await as.bob.get("/v1/notifications");
    expect(bell.json.notifications).toEqual([
      expect.objectContaining({ kind: "team.member.added", actor_name: "siteAdmin" }),
    ]);
    await mailer.settle();
    expect(mailer.to(email("bob"))).toEqual([
      expect.objectContaining({ subject: "siteAdmin added you to the finance team on Kobe" }),
    ]);
    // The team's own admin sees who added Bob in the team's audit view and the roster.
    await as.alice.put("/v1/me/teams/active", { teamId: team });
    as.alice.team = team;
    const roster = await as.alice.get("/v1/team/members");
    expect(roster.json.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: ids.bob, addedVia: "site_admin", deactivated: false }),
      ]),
    );
    const teamAudit = await as.alice.get("/v1/team/audit?action=identity.member.added");
    expect(JSON.stringify(teamAudit.json)).toContain(ids.bob);
    // Review M1: the team's admins are told, naming the Site admin, the member and the role.
    expect(await adminNotices("team.site_admin.member_added")).toEqual([
      { actor_user_id: ids.siteAdmin, subject_user_id: ids.bob, team_role: "contributor" },
    ]);
    const aliceBell = await as.alice.get("/v1/notifications");
    expect(aliceBell.json.notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "team.site_admin.member_added",
          actor_name: "siteAdmin",
          subject_name: "bob",
          team_role: "contributor",
        }),
      ]),
    );
    expect(mailer.to(email("alice"))).toEqual([
      expect.objectContaining({
        subject: "A site admin changed the finance team's members on Kobe",
        text: expect.stringContaining("siteAdmin, a site admin, added bob to the finance team"),
      }),
    ]);
    // Never the added member (they have their own notice), never the Site admin.
    const { rows } = await adminPg.query(
      `SELECT user_id FROM notifications WHERE kind LIKE 'team.site_admin.%' AND user_id = ANY($1)`,
      [[ids.bob, ids.siteAdmin]],
    );
    expect(rows).toEqual([]);
  });

  it("refuses an account whose address is not verified, like an invitation (review L1)", async () => {
    expect(
      await as.siteAdmin.post(members(), { userIds: [ids.unv], role: "member" }),
    ).toMatchObject({ status: 409, json: { code: "user_unverified", userId: ids.unv } });
    expect(await row("unv")).toBeNull();
    const all = await as.siteAdmin.get(`/v1/site/teams/${team}/candidates?q=unv`);
    expect(all.json.candidates).toEqual([]);
  });

  it("revokes the person's pending invitation to the team, audited (review L3)", async () => {
    const invite = await as.alice.post("/v1/team/invites", { email: email("fay"), role: "member" });
    expect(invite.status, JSON.stringify(invite.json)).toBe(202);
    const seq = await lastSeq();
    expect(
      (await as.siteAdmin.post(members(), { userIds: [ids.fay], role: "member" })).status,
    ).toBe(201);
    const { rows } = await adminPg.query(
      `SELECT id FROM team_invitations WHERE team_id = $1 AND email = $2`,
      [team, email("fay")],
    );
    expect(rows).toEqual([]);
    const { rows: revoked } = await adminPg.query(
      `SELECT actor_id FROM audit_log WHERE seq > $1 AND action = 'identity.team_invitation.revoked' AND team_id = $2`,
      [seq, team],
    );
    expect(revoked).toEqual([{ actor_id: ids.siteAdmin }]);
  });

  it("adds several users in one call", async () => {
    const res = await as.owner.post(members(), {
      userIds: [ids.carol, ids.dave],
      role: "member",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(await row("carol")).toEqual({ role: "member", added_via: "site_admin" });
    expect(await row("dave")).toEqual({ role: "member", added_via: "site_admin" });
  });

  it("refuses the whole Add for a deactivated, unknown or existing member, adding nobody", async () => {
    const add = (userIds: string[]) =>
      as.siteAdmin.post(members(), { userIds: [ids.erin, ...userIds], role: "member" });
    expect(await add([ids.gone])).toMatchObject({
      status: 409,
      json: { code: "user_deactivated", userId: ids.gone },
    });
    expect(await add([randomUUID()])).toMatchObject({
      status: 404,
      json: { code: "user_not_found" },
    });
    expect(await add([ids.bob])).toMatchObject({
      status: 409,
      json: { code: "already_member", userId: ids.bob },
    });
    expect(await row("erin")).toBeNull();
    expect(await row("gone")).toBeNull();
    expect((await as.siteAdmin.post(members(), { userIds: [], role: "member" })).status).toBe(400);
    expect(
      (await as.siteAdmin.post(members(), { userIds: [ids.erin], role: "owner" })).status,
    ).toBe(400);
  });

  it("refuses a Site admin adding themselves (break-glass is the way in)", async () => {
    for (const who of ["siteAdmin", "owner"] as const) {
      const res = await as[who].post(members(other), {
        userIds: [ids.erin, ids[who]],
        role: "team_admin",
      });
      expect(res).toMatchObject({ status: 403, json: { code: "self_add_refused" } });
      expect(await row(who, other)).toBeNull();
    }
    expect(await row("erin", other)).toBeNull();
  });

  it("never changes a site role", async () => {
    await as.siteAdmin.post(members(other), { userIds: [ids.owner], role: "team_admin" });
    const { rows } = await adminPg.query(`SELECT user_id, role FROM site_roles ORDER BY role`);
    expect(rows).toEqual(
      expect.arrayContaining([
        { user_id: ids.owner, role: "owner" },
        { user_id: ids.siteAdmin, role: "admin" },
      ]),
    );
    expect(rows).toHaveLength(2);
  });
});

describe("role change and removal (ac-3, ac-4)", () => {
  it("changes a role through teams/members.ts, audited via site_admin, keeping how they joined", async () => {
    const seq = await lastSeq();
    const res = await as.siteAdmin.patch(`${members()}/${ids.bob}`, {
      role: "team_admin",
      expectedRole: "contributor",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(await row("bob")).toEqual({ role: "team_admin", added_via: "site_admin" });
    expect(await auditSince(seq)).toEqual([
      expect.objectContaining({
        action: "identity.member.role_changed",
        actor_id: ids.siteAdmin,
        target: { userId: ids.bob, from: "contributor", to: "team_admin", via: "site_admin" },
      }),
    ]);
    expect(
      await as.siteAdmin.patch(`${members()}/${ids.bob}`, {
        role: "member",
        expectedRole: "contributor",
      }),
    ).toMatchObject({ status: 409, json: { code: "changed_since_approval" } });
    // Review M1: Alice (team admin) is told; Bob, now a team admin too, is the subject, not told.
    expect(await adminNotices("team.site_admin.member_role_changed")).toEqual([
      { actor_user_id: ids.siteAdmin, subject_user_id: ids.bob, team_role: "team_admin" },
    ]);
  });

  it("never drops the last active team admin", async () => {
    // Ops has Alice as its only team admin (the Owner was added as a team admin above: demote).
    expect(
      (await as.siteAdmin.patch(`${members(other)}/${ids.owner}`, { role: "member" })).status,
    ).toBe(200);
    expect(
      await as.siteAdmin.patch(`${members(other)}/${ids.alice}`, { role: "member" }),
    ).toMatchObject({ status: 409, json: { code: "last_team_admin" } });
    expect(await as.siteAdmin.delete(`${members(other)}/${ids.alice}`)).toMatchObject({
      status: 409,
      json: { code: "last_team_admin" },
    });
    expect(await row("alice", other)).toEqual({ role: "team_admin", added_via: null });
  });

  it("removes a member with the Team console's side effects (schedules paused)", async () => {
    const scheduleId = randomUUID();
    await adminPg.query(
      `INSERT INTO schedules (team_id, id, user_id, agent_id, prompt, recurrence, cron, tz, active, next_due_at)
       VALUES ($1, $2, $3, $4, 'daily report', '{"kind":"daily","time":"09:00"}', '0 9 * * *', 'UTC', true, now() + interval '1 day')`,
      [team, scheduleId, ids.dave, randomUUID()],
    );
    const seq = await lastSeq();
    expect((await as.siteAdmin.delete(`${members()}/${ids.dave}?expectedRole=member`)).status).toBe(
      204,
    );
    expect(await row("dave")).toBeNull();
    const { rows } = await adminPg.query(`SELECT active FROM schedules WHERE id = $1`, [
      scheduleId,
    ]);
    expect(rows[0]).toEqual({ active: false });
    expect(await auditSince(seq)).toEqual([
      expect.objectContaining({
        action: "identity.member.removed",
        team_id: team,
        actor_id: ids.siteAdmin,
        target: { userId: ids.dave, role: "member", via: "site_admin" },
      }),
    ]);
    expect((await as.siteAdmin.delete(`${members()}/${ids.dave}`)).status).toBe(404);
    expect(
      await as.siteAdmin.delete(`${members()}/${ids.fay}?expectedRole=contributor`),
    ).toMatchObject({ status: 409, json: { code: "changed_since_approval" } });
    expect(await adminNotices("team.site_admin.member_removed")).toEqual([
      { actor_user_id: ids.siteAdmin, subject_user_id: ids.dave, team_role: "member" },
    ]);
  });

  it("never changes the caller's own membership here", async () => {
    // The Owner is a member of Ops (added by the Site admin above).
    expect(
      await as.owner.patch(`${members(other)}/${ids.owner}`, { role: "team_admin" }),
    ).toMatchObject({ status: 403, json: { code: "self_change_refused" } });
    expect((await as.owner.delete(`${members(other)}/${ids.owner}`)).status).toBe(403);
    expect(await row("owner", other)).toEqual({ role: "member", added_via: "site_admin" });
  });
});

describe("SSO-managed rows (ac-4)", () => {
  it("refuses role change and removal; an audited Take over makes the row manual", async () => {
    const { rows } = await adminPg.query<{ id: string }>(
      `INSERT INTO sso_providers (slug, display_name, kind, issuer, client_id, subject_claim,
         access_claim, managed_by, enabled)
       VALUES ('entra', 'Contoso', 'oidc', 'https://idp.example.test/entra', 'kobe', 'sub', 'roles', 'helm', true)
       RETURNING id`,
    );
    const providerId = rows[0]?.id ?? "";
    await adminPg.query(
      `INSERT INTO team_members (team_id, user_id, role, added_via) VALUES ($1, $2, 'member', $3)`,
      [team, ids.erin, `idp:${providerId}`],
    );
    const list = await as.siteAdmin.get(members());
    expect(list.json.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: ids.erin,
          addedVia: "idp",
          managedBy: { providerId, providerName: "Contoso" },
        }),
      ]),
    );
    expect(
      await as.siteAdmin.patch(`${members()}/${ids.erin}`, { role: "contributor" }),
    ).toMatchObject({ status: 409, json: { code: "managed_by_idp" } });
    expect(await as.siteAdmin.delete(`${members()}/${ids.erin}`)).toMatchObject({
      status: 409,
      json: { code: "managed_by_idp" },
    });
    const seq = await lastSeq();
    expect((await as.siteAdmin.post(`${members()}/${ids.erin}/take-over`)).status).toBe(200);
    expect(await row("erin")).toEqual({ role: "member", added_via: null });
    expect(await auditSince(seq)).toEqual([
      expect.objectContaining({
        action: "identity.member.taken_over",
        actor_id: ids.siteAdmin,
        target: { userId: ids.erin, providerId, via: "site_admin" },
      }),
    ]);
    expect(
      (await as.siteAdmin.patch(`${members()}/${ids.erin}`, { role: "contributor" })).status,
    ).toBe(200);
  });
});

describe("roster (ac-1)", () => {
  it("shows name, email, role, how they joined and status", async () => {
    await adminPg.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [ids.carol]);
    const list = await as.siteAdmin.get(members());
    const byId = new Map(list.json.members.map((m: { userId: string }) => [m.userId, m] as const));
    expect(byId.get(ids.alice)).toMatchObject({
      name: "alice",
      email: email("alice"),
      role: "team_admin",
      addedVia: null,
      deactivated: false,
    });
    expect(byId.get(ids.carol)).toMatchObject({ addedVia: "site_admin", deactivated: true });
    await adminPg.query(`UPDATE users SET deactivated_at = NULL WHERE id = $1`, [ids.carol]);
  });
});
