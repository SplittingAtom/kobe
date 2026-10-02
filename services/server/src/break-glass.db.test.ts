import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, testServerUrl, type TestDatabase } from "@kobe/db/testing";
import { createApp } from "./app.js";
import { sweepBreakGlass } from "./break-glass/sweeper.js";
import { createServerDeps, type ServerDeps } from "./deps.js";
import { TestBrowser } from "./testing/browser.js";
import { MemoryMailer } from "./testing/mailer.js";

// KOBE-16 break-glass end to end: request, two-person approval, notifications, audited reads
// through their own routes only, revocation and expiry re-checked per request, races.
const PUBLIC_URL = "http://kobe.test";
const PASSWORD = "a long enough password";

const PEOPLE = ["owner", "investigator", "alice", "bob", "carol", "dave", "erin"] as const;
type Person = (typeof PEOPLE)[number];
const ids = Object.fromEntries(PEOPLE.map((p) => [p, ""])) as Record<Person, string>;
const email = (who: Person) => `${who}@bg.test`;

let database: TestDatabase;
let deps: ServerDeps;
let mailer: MemoryMailer;
let app: ReturnType<typeof createApp>;
let admin: pg.Client;
let as: Record<Person, TestBrowser>;
// finance: alice team_admin, bob and carol members. marketing: dave team_admin.
let finance = "";
let marketing = "";
let aliceThread = "";
let bobThread = "";
let marketingThread = "";
let ops = ""; // erin is its only team admin

async function signIn(who: Person): Promise<TestBrowser> {
  const b = new TestBrowser(app, PUBLIC_URL);
  const res = await b.post("/api/auth/sign-in/email", { email: email(who), password: PASSWORD });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return b;
}

async function activate(b: TestBrowser, teamId: string): Promise<void> {
  const res = await b.put("/v1/me/teams/active", { teamId });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  b.team = teamId;
}

async function addMember(by: TestBrowser, who: Person, role: string): Promise<void> {
  const res = await by.post("/v1/team/invites", { email: email(who), role });
  expect(res.status, JSON.stringify(res.json)).toBe(202);
  const accepted = await as[who].post(`/v1/me/invites/${by.team}/accept`);
  expect(accepted.status, JSON.stringify(accepted.json)).toBe(200);
}

async function newThread(b: TestBrowser, entries: number): Promise<string> {
  const res = await b.post("/v1/threads", { title: "secret plans" });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  const id = res.json.thread_id as string;
  let parent: string | null = null;
  for (let i = 1; i <= entries; i++) {
    await admin.query(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
       VALUES ($1, $2, $3, $4, 'message', $5)`,
      [
        b.team,
        id,
        `e${i}`,
        parent,
        JSON.stringify({ message: { role: "user", content: `body ${i}` } }),
      ],
    );
    parent = `e${i}`;
  }
  return id;
}

interface RequestBody {
  teamId?: string;
  reason?: string;
  durationMinutes?: number;
  userId?: string;
  threadId?: string;
  legalHold?: boolean;
}

async function requestGrant(body: RequestBody = {}, by: Person = "investigator"): Promise<string> {
  const res = await as[by].post("/v1/install/break-glass", {
    teamId: finance,
    reason: "Incident 42: suspected data exfiltration",
    ...body,
  });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json.grant.id as string;
}

async function activeGrant(body: RequestBody = {}): Promise<string> {
  const id = await requestGrant(body);
  const res = await as.owner.post(`/v1/install/break-glass/${id}/approve`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return id;
}

async function auditFor(
  grantId: string,
): Promise<
  { action: string; team_id: string; actor_id: string | null; target: Record<string, unknown> }[]
> {
  const { rows } = await admin.query(
    `SELECT action, team_id, actor_id, target FROM audit_log WHERE target->>'grantId' = $1 ORDER BY seq`,
    [grantId],
  );
  return rows;
}

/** Waits for fire-and-forget notifications (they query the database before sending). */
async function mailTo(who: Person, count: number) {
  const deadline = Date.now() + 5_000;
  while (mailer.to(email(who)).length < count && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return mailer.to(email(who));
}

async function settled(): Promise<void> {
  await new Promise((r) => setTimeout(r, 300));
}

function mailCounts(): Record<Person, number> {
  return Object.fromEntries(PEOPLE.map((p) => [p, mailer.to(email(p)).length])) as Record<
    Person,
    number
  >;
}

beforeAll(async () => {
  database = await createTestDatabase(testServerUrl());
  admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
  mailer = new MemoryMailer();
  deps = createServerDeps({
    databaseUrl: database.appUrl,
    publicUrl: PUBLIC_URL,
    authSecret: "b".repeat(48),
    setupToken: "setup-token-for-break-glass-01",
    trustedProxies: ["127.0.0.1/32"],
    mailer,
  });
  app = createApp(deps);
  for (const who of PEOPLE) {
    const installRole = who === "owner" ? "owner" : who === "investigator" ? "admin" : undefined;
    const user = await deps.createUserWithPassword(
      { email: email(who), name: who, password: PASSWORD },
      installRole ? { installRole } : {},
    );
    ids[who] = user.id;
  }
  as = Object.fromEntries(
    await Promise.all(PEOPLE.map(async (w) => [w, await signIn(w)])),
  ) as Record<Person, TestBrowser>;
  const create = async (slug: string, adminUser: Person) => {
    const res = await as.owner.post("/v1/install/teams", {
      slug,
      name: slug,
      adminUserId: ids[adminUser],
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    return res.json.team.id as string;
  };
  finance = await create("finance", "alice");
  marketing = await create("marketing", "dave");
  ops = await create("ops", "erin");
  await activate(as.alice, finance);
  await addMember(as.alice, "bob", "member");
  await addMember(as.alice, "carol", "member");
  await activate(as.bob, finance);
  await activate(as.dave, marketing);
  aliceThread = await newThread(as.alice, 3);
  bobThread = await newThread(as.bob, 1);
  marketingThread = await newThread(as.dave, 1);
});

/** Open requests are capped per admin (3): withdraw what a test left pending. */
afterEach(async () => {
  await admin.query(`SET session_replication_role = replica`);
  await admin.query(
    `UPDATE break_glass_grants SET status = 'revoked', decided_by = admin_id, decided_at = now(),
       ended_at = now() WHERE status = 'pending'`,
  );
  await admin.query(`SET session_replication_role = origin`);
});

async function waitForAppSessionsToClose(): Promise<void> {
  const server = new pg.Client({ connectionString: testServerUrl() });
  await server.connect();
  try {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { rows } = await server.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = $1`,
        [database.appRole],
      );
      if (rows[0]?.n === 0) return;
      if (Date.now() > deadline) throw new Error("app-role sessions still open after 10 s");
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    await server.end();
  }
}

afterAll(async () => {
  await settled();
  await deps?.close();
  await admin?.end();
  if (database) {
    await waitForAppSessionsToClose();
    await database.drop();
  }
});

describe("requesting (POST /v1/install/break-glass)", () => {
  it("records a pending request under the team and asks the other install admins", async () => {
    const before = mailCounts();
    const res = await as.investigator.post("/v1/install/break-glass", {
      teamId: finance,
      reason: "Incident 42: suspected data exfiltration",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.grant).toMatchObject({
      status: "pending",
      scope: "team",
      durationMinutes: 60,
      legalHold: false,
      requestedBy: { id: ids.investigator },
      actions: { approve: false, deny: false, revoke: true, read: false },
    });
    const grantId = res.json.grant.id as string;
    expect(await auditFor(grantId)).toEqual([
      {
        action: "governance.break_glass.requested",
        team_id: finance,
        actor_id: ids.investigator,
        // The owner is the only other install admin.
        target: { grantId, scope: "team", legalHold: false, durationMinutes: 60, recipients: 1 },
      },
    ]);
    const ownerMail = await mailTo("owner", before.owner + 1);
    expect(ownerMail.at(-1)?.subject).toContain("needs a second admin");
    expect(ownerMail.at(-1)?.text).toContain("Incident 42");
    await settled();
    // Nobody on the team hears about a request that grants nothing yet; the requester neither.
    expect(mailCounts()).toMatchObject({ ...before, owner: before.owner + 1 });
  });

  it("validates the scope: one narrowing, a member subject, a bounded window, a real reason", async () => {
    const post = (body: object) =>
      as.investigator.post("/v1/install/break-glass", {
        teamId: finance,
        reason: "Long enough reason",
        ...body,
      });
    expect((await post({ userId: ids.bob, threadId: bobThread })).status).toBe(400);
    expect((await post({ durationMinutes: 24 * 60 + 1 })).status).toBe(400);
    expect((await post({ reason: "short" })).status).toBe(400);
    expect((await post({ userId: ids.dave })).json.code).toBe("subject_not_member");
    expect((await post({ teamId: "00000000-0000-4000-8000-000000000000" })).json.code).toBe(
      "team_not_found",
    );
    expect((await post({ unknown: 1 })).status).toBe(400);
  });

  it("is for install admins only: members and team admins get 403 everywhere", async () => {
    const grantId = await requestGrant();
    for (const who of ["alice", "bob"] as const) {
      expect((await as[who].get("/v1/install/break-glass")).status).toBe(403);
      expect(
        (await as[who].post("/v1/install/break-glass", { teamId: finance, reason: "x".repeat(20) }))
          .status,
      ).toBe(403);
      expect((await as[who].post(`/v1/install/break-glass/${grantId}/approve`)).status).toBe(403);
      expect((await as[who].get(`/v1/install/break-glass/${grantId}/threads`)).status).toBe(403);
    }
  });
});

describe("two-person approval", () => {
  it("refuses self-approval while a second install admin exists", async () => {
    const grantId = await requestGrant();
    const res = await as.investigator.post(`/v1/install/break-glass/${grantId}/approve`);
    expect(res.status).toBe(403);
    expect(res.json.code).toBe("self_approval_forbidden");
    expect(
      (await as.investigator.get(`/v1/install/break-glass/${grantId}`)).json.grant.status,
    ).toBe("pending");
    expect((await auditFor(grantId)).map((a) => a.action)).toEqual([
      "governance.break_glass.requested",
    ]);
  });

  it("activates on a second admin's approval, time-boxed, and notifies team admins and admins", async () => {
    const before = mailCounts();
    const grantId = await requestGrant({ userId: ids.bob, durationMinutes: 30 });
    const res = await as.owner.post(`/v1/install/break-glass/${grantId}/approve`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const grant = res.json.grant;
    expect(grant).toMatchObject({
      status: "active",
      selfApproved: false,
      approvedBy: { id: ids.owner },
    });
    expect(Date.parse(grant.expiresAt) - Date.parse(grant.startsAt)).toBe(30 * 60_000);
    // alice (team admin), the requester, bob (subject); the approver isn't told of their own act.
    expect(res.json.notified).toEqual({ recipients: 3, teamAdmins: 1 });
    expect(res.json.warnings).toEqual([]);
    const approved = (await auditFor(grantId)).at(-1);
    expect(approved).toMatchObject({
      action: "governance.break_glass.approved",
      team_id: finance,
      actor_id: ids.owner,
      target: {
        grantId,
        scope: "user",
        subjectUserId: ids.bob,
        legalHold: false,
        selfApproved: false,
      },
    });
    // Team admin (alice), the requester, and the subject (bob) are told; the other team's admin
    // (dave), other members (carol) and the approver themself are not.
    const alice = await mailTo("alice", before.alice + 1);
    expect(alice.at(-1)?.subject).toBe("Break-glass access to the finance team was approved");
    expect(alice.at(-1)?.text).toContain("every read".replace("every", "Every"));
    expect(alice.at(-1)?.text).toContain("/admin/team/break-glass");
    await mailTo("investigator", before.investigator + 1);
    await mailTo("bob", before.bob + 1);
    await settled();
    expect(mailCounts()).toEqual({
      ...before,
      alice: before.alice + 1,
      investigator: before.investigator + 1,
      bob: before.bob + 1,
      // The request itself went to the owner.
      owner: before.owner + 1,
    });
  });

  it("legal hold: the subject is not notified, and the team view hides reason and subject", async () => {
    const before = mailCounts();
    const grantId = await requestGrant({ userId: ids.bob, legalHold: true });
    await as.owner.post(`/v1/install/break-glass/${grantId}/approve`);
    const alice = await mailTo("alice", before.alice + 1);
    expect(alice.at(-1)?.text).toContain("restricted (legal hold)");
    expect(alice.at(-1)?.text).not.toContain("Incident 42");
    await settled();
    expect(mailer.to(email("bob")).length).toBe(before.bob);
    const view = await as.alice.get("/v1/team/break-glass");
    const shown = view.json.active.find((g: { id: string }) => g.id === grantId);
    expect(shown).toMatchObject({
      scope: "restricted",
      subject: null,
      reason: null,
      legalHold: true,
    });
  });

  it("hides a legal hold from a subject who is an install admin, who can't end it either", async () => {
    await admin.query(`INSERT INTO install_roles (user_id, role) VALUES ($1, 'admin')`, [
      ids.carol,
    ]);
    try {
      const grantId = await activeGrant({ userId: ids.carol, legalHold: true });
      const list = await as.carol.get("/v1/install/break-glass");
      expect(list.json.grants.map((g: { id: string }) => g.id)).not.toContain(grantId);
      expect((await as.carol.get(`/v1/install/break-glass/${grantId}`)).status).toBe(404);
      // Deciding answers exactly like the hidden grant's GET: 404, so nothing leaks.
      for (const action of ["approve", "deny", "revoke"]) {
        const res = await as.carol.post(`/v1/install/break-glass/${grantId}/${action}`);
        expect([res.status, res.json.code], action).toEqual([404, "grant_not_found"]);
      }
      expect((await as.owner.get(`/v1/install/break-glass/${grantId}`)).json.grant.status).toBe(
        "active",
      );
      await settled();
      expect(mailer.to(email("carol")).filter((m) => /break-glass/i.test(m.subject))).toEqual([]);
    } finally {
      await admin.query(`DELETE FROM install_roles WHERE user_id = $1`, [ids.carol]);
    }
  });

  it("lets an install with one active admin self-approve, flagged (D10: deactivated admins don't count)", async () => {
    await admin.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [ids.owner]);
    try {
      const before = mailer.to(email("alice")).length;
      const grantId = await requestGrant();
      const list = await as.investigator.get("/v1/install/break-glass");
      expect(list.json.selfApprovalAllowed).toBe(true);
      const res = await as.investigator.post(`/v1/install/break-glass/${grantId}/approve`);
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(res.json.grant).toMatchObject({ status: "active", selfApproved: true });
      expect((await auditFor(grantId)).at(-1)?.target).toMatchObject({ selfApproved: true });
      const alice = await mailTo("alice", before + 1);
      expect(alice.at(-1)?.text).toContain("approved it alone");
    } finally {
      await admin.query(`UPDATE users SET deactivated_at = NULL WHERE id = $1`, [ids.owner]);
    }
  });

  it("denial by another admin tells the requester; the requester can't deny their own", async () => {
    const grantId = await requestGrant();
    expect((await as.investigator.post(`/v1/install/break-glass/${grantId}/deny`)).json.code).toBe(
      "cannot_deny_own",
    );
    const before = mailer.to(email("investigator")).length;
    const res = await as.owner.post(`/v1/install/break-glass/${grantId}/deny`);
    expect(res.json.grant.status).toBe("denied");
    expect((await mailTo("investigator", before + 1)).at(-1)?.subject).toContain("was denied");
    expect((await as.owner.post(`/v1/install/break-glass/${grantId}/approve`)).json.code).toBe(
      "not_pending",
    );
    expect((await auditFor(grantId)).map((a) => a.action)).toEqual([
      "governance.break_glass.requested",
      "governance.break_glass.denied",
    ]);
  });
});

describe("reading under a grant", () => {
  it("is refused before approval", async () => {
    const grantId = await requestGrant();
    const res = await as.investigator.get(`/v1/install/break-glass/${grantId}/threads`);
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: "grant_not_active", status: "pending" });
  });

  it("reads the team's threads and entries read-only, and audits every read in the team view", async () => {
    const grantId = await activeGrant();
    const list = await as.investigator.get(`/v1/install/break-glass/${grantId}/threads`);
    expect(list.status, JSON.stringify(list.json)).toBe(200);
    expect(list.json.threads.map((t: { thread_id: string }) => t.thread_id).sort()).toEqual(
      [aliceThread, bobThread].sort(),
    );
    const thread = await as.investigator.get(
      `/v1/install/break-glass/${grantId}/threads/${aliceThread}`,
    );
    expect(thread.json.thread).toMatchObject({ thread_id: aliceThread, title: "secret plans" });
    const entries = await as.investigator.get(
      `/v1/install/break-glass/${grantId}/threads/${aliceThread}/entries?limit=2`,
    );
    expect(entries.json.entries.map((e: { entry_id: string }) => e.entry_id)).toEqual(["e1", "e2"]);
    expect(entries.json.next_after).toBe(2);

    const reads = (await auditFor(grantId)).filter(
      (a) => a.action === "governance.break_glass.read",
    );
    expect(reads.map((r) => [r.team_id, r.actor_id, r.target.object])).toEqual([
      [finance, ids.investigator, "thread_list"],
      [finance, ids.investigator, "thread"],
      [finance, ids.investigator, "thread_entries"],
    ]);
    // The team's own audit view (team admins) shows each read, and the banner shows the grant.
    const teamAudit = await as.alice.get(
      "/v1/team/audit?action=governance.break_glass.read&limit=200",
    );
    expect(teamAudit.status).toBe(200);
    const seen = teamAudit.json.events.filter(
      (e: { target: { grantId: string } }) => e.target.grantId === grantId,
    );
    expect(seen).toHaveLength(3);
    const banner = await as.alice.get("/v1/team/break-glass");
    expect(banner.json.active.map((g: { id: string }) => g.id)).toContain(grantId);
    expect(banner.json.active.find((g: { id: string }) => g.id === grantId)).toMatchObject({
      requestedBy: { id: ids.investigator, name: "investigator" },
      reason: "Incident 42: suspected data exfiltration",
    });
    // The other team sees nothing of it.
    const other = await as.dave.get("/v1/team/break-glass");
    expect(other.json.active).toEqual([]);
    expect((await as.dave.get("/v1/team/audit?category=governance")).json.events).toEqual([]);
  });

  it("offers no write: only GET routes exist for reads", async () => {
    const grantId = await activeGrant();
    for (const [method, path] of [
      ["POST", `/v1/install/break-glass/${grantId}/threads`],
      ["PATCH", `/v1/install/break-glass/${grantId}/threads/${aliceThread}`],
      ["POST", `/v1/install/break-glass/${grantId}/threads/${aliceThread}/entries`],
      ["DELETE", `/v1/install/break-glass/${grantId}/threads/${aliceThread}`],
    ] as const) {
      expect((await as.investigator.request(method, path, {})).status, `${method} ${path}`).toBe(
        404,
      );
    }
  });

  it("never opens the normal team routes, even while a grant is active", async () => {
    await activeGrant();
    // The investigator is no member: they can't make the team active, and thread routes refuse.
    expect((await as.investigator.put("/v1/me/teams/active", { teamId: finance })).status).toBe(
      403,
    );
    expect(
      (await as.investigator.get(`/v1/threads/${aliceThread}`, { "x-kobe-team": finance })).status,
    ).toBe(409);
    expect((await as.investigator.get("/v1/team/audit")).status).toBe(409);
  });

  it("narrows a user grant to the subject's threads; out-of-scope reads are 404 and not audited", async () => {
    const grantId = await activeGrant({ userId: ids.bob });
    const list = await as.investigator.get(`/v1/install/break-glass/${grantId}/threads`);
    expect(list.json.threads.map((t: { thread_id: string }) => t.thread_id)).toEqual([bobThread]);
    for (const path of [
      `threads/${aliceThread}`,
      `threads/${aliceThread}/entries`,
      `threads/${marketingThread}`,
    ]) {
      const res = await as.investigator.get(`/v1/install/break-glass/${grantId}/${path}`);
      expect(res.status, path).toBe(404);
      expect(res.json.code).toBe("thread_not_found");
    }
    expect(
      (await auditFor(grantId)).filter((a) => a.action === "governance.break_glass.read"),
    ).toHaveLength(1);
  });

  it("narrows a thread grant to that thread", async () => {
    const grantId = await activeGrant({ threadId: aliceThread });
    const list = await as.investigator.get(`/v1/install/break-glass/${grantId}/threads`);
    expect(list.json.threads.map((t: { thread_id: string }) => t.thread_id)).toEqual([aliceThread]);
    expect(
      (await as.investigator.get(`/v1/install/break-glass/${grantId}/threads/${bobThread}`)).status,
    ).toBe(404);
  });

  it("is usable only by the requester", async () => {
    const grantId = await activeGrant();
    const res = await as.owner.get(`/v1/install/break-glass/${grantId}/threads`);
    expect(res.status).toBe(404);
    expect(res.json.code).toBe("grant_not_found");
  });
});

describe("ending a grant", () => {
  it("revocation applies to the very next request, and the team is told", async () => {
    const grantId = await activeGrant();
    const path = `/v1/install/break-glass/${grantId}/threads`;
    expect((await as.investigator.get(path)).status).toBe(200);
    const before = mailer.to(email("alice")).length;
    const revoked = await as.owner.post(`/v1/install/break-glass/${grantId}/revoke`);
    expect(revoked.json.grant.status).toBe("revoked");
    const denied = await as.investigator.get(path);
    expect(denied.status).toBe(403);
    expect(denied.json).toMatchObject({ code: "grant_not_active", status: "revoked" });
    expect((await mailTo("alice", before + 1)).at(-1)?.subject).toContain("was revoked");
    expect((await auditFor(grantId)).at(-1)).toMatchObject({
      action: "governance.break_glass.revoked",
      target: { grantId, wasActive: true },
    });
    expect((await as.owner.post(`/v1/install/break-glass/${grantId}/revoke`)).json.code).toBe(
      "not_open",
    );
  });

  it("expiry ends access without the sweep; the sweep records it once and notifies", async () => {
    const grantId = await activeGrant();
    await admin.query(`SET session_replication_role = replica`);
    await admin.query(
      `UPDATE break_glass_grants SET starts_at = now() - interval '2 hours', expires_at = now() - interval '1 second' WHERE id = $1`,
      [grantId],
    );
    await admin.query(`SET session_replication_role = origin`);
    const res = await as.investigator.get(`/v1/install/break-glass/${grantId}/threads`);
    expect(res.status).toBe(403);
    expect(
      (await as.investigator.get(`/v1/install/break-glass/${grantId}`)).json.grant.status,
    ).toBe("expired");

    const before = mailer.to(email("alice")).length;
    const [first, second] = await Promise.all([sweepBreakGlass(deps), sweepBreakGlass(deps)]);
    expect((first ?? 0) + (second ?? 0)).toBeGreaterThanOrEqual(1);
    const expired = (await auditFor(grantId)).filter(
      (a) => a.action === "governance.break_glass.expired",
    );
    expect(expired).toEqual([
      {
        action: "governance.break_glass.expired",
        team_id: finance,
        actor_id: null,
        // alice (team admin), the owner (approver) and the requester.
        target: { grantId, wasActive: true, recipients: 3, teamAdmins: 1 },
      },
    ]);
    expect((await mailTo("alice", before + 1)).at(-1)?.subject).toContain("ended");
  });

  it("approve racing revoke always ends revoked, with a consistent audit trail", async () => {
    for (let i = 0; i < 6; i++) {
      const grantId = await requestGrant();
      const [approve, revoke] = await Promise.all([
        as.owner.post(`/v1/install/break-glass/${grantId}/approve`),
        as.investigator.post(`/v1/install/break-glass/${grantId}/revoke`),
      ]);
      expect(revoke.status, JSON.stringify(revoke.json)).toBe(200);
      const actions = (await auditFor(grantId)).map((a) => a.action);
      const final = (await as.investigator.get(`/v1/install/break-glass/${grantId}`)).json.grant;
      expect(final.status).toBe("revoked");
      if (approve.status === 200) {
        expect(actions).toEqual([
          "governance.break_glass.requested",
          "governance.break_glass.approved",
          "governance.break_glass.revoked",
        ]);
        expect((await auditFor(grantId)).at(-1)?.target).toMatchObject({ wasActive: true });
      } else {
        expect(approve.json.code).toBe("not_pending");
        expect(actions).toEqual([
          "governance.break_glass.requested",
          "governance.break_glass.revoked",
        ]);
        expect((await auditFor(grantId)).at(-1)?.target).toMatchObject({ wasActive: false });
      }
      expect((await as.investigator.get(`/v1/install/break-glass/${grantId}/threads`)).status).toBe(
        403,
      );
    }
  });

  it("refuses reads after the requester loses the admin role", async () => {
    const grantId = await activeGrant();
    expect(
      (await as.owner.put(`/v1/install/roles/${ids.investigator}`, { role: "user" })).status,
    ).toBe(200);
    try {
      expect((await as.investigator.get(`/v1/install/break-glass/${grantId}/threads`)).status).toBe(
        403,
      );
    } finally {
      await as.owner.put(`/v1/install/roles/${ids.investigator}`, { role: "admin" });
    }
  });
});

describe("durable notifications and limits", () => {
  async function outbox(grantId: string) {
    const { rows } = await admin.query<{
      status: string;
      attempts: number;
      last_error: string | null;
      event: string;
    }>(
      `SELECT status::text, attempts, last_error, event FROM break_glass_notifications
       WHERE grant_id = $1 ORDER BY created_at, id`,
      [grantId],
    );
    return rows;
  }

  it("queues notifications with the approval; a failed send stays pending and the sweep retries it", async () => {
    const grantId = await requestGrant();
    await settled();
    mailer.failNext = new Error("SMTP down");
    const before = mailer.to(email("alice")).length;
    const res = await as.owner.post(`/v1/install/break-glass/${grantId}/approve`);
    expect(res.status).toBe(200);
    await settled();
    const approved = (await outbox(grantId)).filter((r) => r.event === "approved");
    expect(approved.length).toBe(res.json.notified.recipients);
    const failed = approved.filter((r) => r.status === "pending");
    expect(failed).toEqual([
      { status: "pending", attempts: 1, last_error: "smtp_error", event: "approved" },
    ]);
    // Due again (backoff elapsed): the sweep delivers it.
    await admin.query(
      `UPDATE break_glass_notifications SET next_attempt_at = now() WHERE grant_id = $1 AND status = 'pending'`,
      [grantId],
    );
    await sweepBreakGlass(deps);
    expect((await outbox(grantId)).every((r) => r.status === "sent")).toBe(true);
    expect(mailer.to(email("alice")).length).toBe(before + 1);
  });

  it("gives up after the last attempt and audits the failure", async () => {
    const grantId = await activeGrant();
    await settled();
    await admin.query(
      `UPDATE break_glass_notifications SET status = 'pending', attempts = 7, next_attempt_at = now()
       WHERE id = (SELECT id FROM break_glass_notifications WHERE grant_id = $1 AND event = 'approved' LIMIT 1)`,
      [grantId],
    );
    mailer.failNext = new Error("SMTP down");
    await sweepBreakGlass(deps);
    expect((await outbox(grantId)).filter((r) => r.status === "failed")).toHaveLength(1);
    expect((await auditFor(grantId)).at(-1)).toMatchObject({
      action: "governance.break_glass.notification_failed",
      actor_id: null,
      target: { grantId, event: "approved", attempts: 8 },
    });
  });

  it("still approves when no team admin can be told, and says so in the response and the audit", async () => {
    await admin.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [ids.erin]);
    try {
      const grantId = await requestGrant({ teamId: ops });
      const res = await as.owner.post(`/v1/install/break-glass/${grantId}/approve`);
      expect(res.status).toBe(200);
      expect(res.json.notified.teamAdmins).toBe(0);
      expect(res.json.warnings.map((w: { code: string }) => w.code)).toEqual([
        "no_team_admin_notified",
      ]);
      expect((await auditFor(grantId)).at(-1)?.target).toMatchObject({ teamAdmins: 0 });
    } finally {
      await admin.query(`UPDATE users SET deactivated_at = NULL WHERE id = $1`, [ids.erin]);
    }
  });

  it("refuses state changes from another origin", async () => {
    const res = await as.investigator.request(
      "POST",
      "/v1/install/break-glass",
      { teamId: finance, reason: "Incident 42: suspected data exfiltration" },
      { origin: "http://evil.test" },
    );
    expect([res.status, res.json.code]).toEqual([403, "forbidden_origin"]);
    const grantId = await requestGrant();
    const approve = await as.owner.request(
      "POST",
      `/v1/install/break-glass/${grantId}/approve`,
      {},
      { origin: "http://evil.test" },
    );
    expect(approve.status).toBe(403);
  });

  it("caps open requests per admin", async () => {
    for (let i = 0; i < 3; i++) await requestGrant();
    const res = await as.investigator.post("/v1/install/break-glass", {
      teamId: finance,
      reason: "Incident 42: suspected data exfiltration",
    });
    expect([res.status, res.json.code]).toEqual([429, "too_many_pending"]);
  });

  it("rate-limits reads per admin", async () => {
    const grantId = await activeGrant();
    const key = `kobe:break-glass-read:${ids.investigator}`;
    await admin.query(
      `INSERT INTO rate_limits (key, count, last_request) VALUES ($1, 120, $2)
       ON CONFLICT (key) DO UPDATE SET count = 120, last_request = $2`,
      [key, Date.now()],
    );
    try {
      const res = await as.investigator.get(`/v1/install/break-glass/${grantId}/threads`);
      expect([res.status, res.json.code]).toEqual([429, "rate_limited"]);
    } finally {
      await admin.query(`DELETE FROM rate_limits WHERE key = $1`, [key]);
    }
  });

  it("revocation wins over a flood of reads", async () => {
    const grantId = await activeGrant();
    const path = `/v1/install/break-glass/${grantId}/threads`;
    const flood = Array.from({ length: 30 }, () => as.investigator.get(path));
    const revoke = as.owner.post(`/v1/install/break-glass/${grantId}/revoke`);
    const [revoked, ...reads] = await Promise.all([revoke, ...flood]);
    expect(revoked?.status, JSON.stringify(revoked?.json)).toBe(200);
    expect(reads.every((r) => r.status === 200 || r.status === 403)).toBe(true);
    expect((await as.investigator.get(path)).status).toBe(403);
    await admin.query(`DELETE FROM rate_limits WHERE key = $1`, [
      `kobe:break-glass-read:${ids.investigator}`,
    ]);
  });
});
