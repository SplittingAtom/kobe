import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuditActor } from "@kobe/db";
import { createTestDatabase, testServerUrl, type TestDatabase } from "@kobe/db/testing";
import { createApp } from "./app.js";
import { createServerDeps, type ServerDeps } from "./deps.js";
import { loadSsoSettings } from "./sso/settings.js";
import {
  UnknownProviderError,
  applyIdpAccess,
  applyIdpAccessAndFollowUp,
  type IdpAccessResult,
} from "./sso/access.js";
import { waitForAppSessionsToClose } from "./testing/app-sessions.js";
import { TestBrowser } from "./testing/browser.js";
import { MemoryMailer } from "./testing/mailer.js";

/**
 * KOBE-627 (spec sso-oidc-scim §7, SSO2/SSO6/SSO10): the access-mapping engine and its rules, the
 * mapping routes, and the Team console's managed rows (refused edits, Take over).
 */
const PUBLIC_URL = "http://kobe.test";
const PASSWORD = "a long enough password";

type Person = "owner" | "siteAdmin" | "alice" | "bob" | "carol" | "dave" | "erin" | "fred";
const PEOPLE: readonly Person[] = [
  "owner",
  "siteAdmin",
  "alice",
  "bob",
  "carol",
  "dave",
  "erin",
  "fred",
];
const ids = {} as Record<Person, string>;
const as = {} as Record<Person, TestBrowser>;
const email = (who: Person) => `${who.toLowerCase()}@sso-access.test`;

let database: TestDatabase;
let deps: ServerDeps;
let app: ReturnType<typeof createApp>;
let adminPg: pg.Client;
let provider = "";
let other = "";
const teams = { finance: "", marketing: "", ops: "" };

const SYSTEM: AuditActor = { kind: "system", id: null };

async function insertProvider(slug: string): Promise<string> {
  const { rows } = await adminPg.query<{ id: string }>(
    `INSERT INTO sso_providers (slug, display_name, kind, issuer, client_id, subject_claim,
       access_claim, managed_by, enabled)
     VALUES ($1, $2, 'oidc', 'https://idp.example.test/' || $1, 'kobe', 'sub', 'roles', 'helm', true)
     RETURNING id`,
    [slug, `IdP ${slug}`],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("provider insert returned no row");
  return id;
}

async function map(providerId: string, claimValue: string, teamId: string, role: string) {
  const res = await as.siteAdmin.post(`/v1/site/sso/providers/${providerId}/mappings`, {
    claimValue,
    teamId,
    role,
  });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json.mapping.id as string;
}

async function row(teamId: string, who: Person) {
  const { rows } = await adminPg.query<{ role: string; added_via: string | null }>(
    `SELECT role, added_via FROM team_members WHERE team_id = $1 AND user_id = $2`,
    [teamId, ids[who]],
  );
  return rows[0] ?? null;
}

async function auditSince(seq: number, action?: string) {
  const { rows } = await adminPg.query<{
    action: string;
    team_id: string | null;
    actor_kind: string;
    actor_id: string | null;
    target: Record<string, unknown>;
  }>(
    `SELECT action, team_id, actor_kind, actor_id, target FROM audit_log
      WHERE seq > $1 AND ($2::text IS NULL OR action = $2) ORDER BY seq`,
    [seq, action ?? null],
  );
  return rows;
}

async function lastSeq(): Promise<number> {
  const { rows } = await adminPg.query<{ s: string }>(
    `SELECT coalesce(max(seq), 0) AS s FROM audit_log`,
  );
  return Number(rows[0]?.s ?? 0);
}

const apply = (who: Person, values: readonly string[], providerId = provider) =>
  applyIdpAccess(deps.database.db, { providerId, userId: ids[who], values, actor: SYSTEM });

async function switchTo(who: Person, teamId: string) {
  const res = await as[who].put("/v1/me/teams/active", { teamId });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  as[who].team = teamId;
}

beforeAll(async () => {
  database = await createTestDatabase(testServerUrl());
  adminPg = new pg.Client({ connectionString: database.adminUrl });
  await adminPg.connect();
  deps = createServerDeps({
    databaseUrl: database.appUrl,
    publicUrl: PUBLIC_URL,
    authSecret: "s".repeat(48),
    setupToken: "setup-token-for-sso-access-0123",
    trustedProxies: ["127.0.0.1/32"],
    mailer: new MemoryMailer(),
    // The mapping routes follow the kill switch (review finding 7).
    sso: { settings: loadSsoSettings({ KOBE_SSO_ENABLED: "true" }) },
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
    ["marketing", "alice"],
    ["ops", "fred"],
  ] as const) {
    const res = await as.owner.post("/v1/site/teams", {
      slug,
      name: slug,
      adminUserId: ids[admin],
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    teams[slug] = res.json.team.id;
  }
  provider = await insertProvider("entra");
  other = await insertProvider("other");
  await map(provider, "kobe.fin.member", teams.finance, "member");
  await map(provider, "kobe.fin.builder", teams.finance, "contributor");
  await map(provider, "kobe.fin.admin", teams.finance, "team_admin");
  await map(provider, "kobe.mkt.member", teams.marketing, "member");
  await map(provider, "kobe.ops.admin", teams.ops, "team_admin");
  await map(other, "kobe.fin.member", teams.finance, "member");
  await switchTo("alice", teams.finance);
});

afterAll(async () => {
  await deps?.close();
  await adminPg?.end();
  if (database) {
    await waitForAppSessionsToClose(database.appRole);
    await database.drop();
  }
});

describe("mapping routes (site.users.manage)", () => {
  it("refuses everyone without site.users.manage", async () => {
    expect((await as.bob.get("/v1/site/sso/mappings")).status).toBe(403);
    expect(
      (
        await as.alice.post(`/v1/site/sso/providers/${provider}/mappings`, {
          claimValue: "x",
          teamId: teams.finance,
          role: "member",
        })
      ).status,
    ).toBe(403);
    expect(
      (await as.alice.delete(`/v1/site/sso/providers/${provider}/mappings/${randomUUID()}`)).status,
    ).toBe(403);
  });

  it("lists providers and mappings, filtered by provider", async () => {
    const all = await as.siteAdmin.get("/v1/site/sso/mappings");
    expect(all.status).toBe(200);
    expect(all.json.providers.map((p: { slug: string }) => p.slug).sort()).toEqual([
      "entra",
      "other",
    ]);
    expect(all.json.mappings).toHaveLength(6);
    expect(all.json.appliesAt).toBe("next_sign_in");
    const one = await as.siteAdmin.get(`/v1/site/sso/mappings?providerId=${other}`);
    expect(one.json.mappings).toEqual([
      expect.objectContaining({
        claimValue: "kobe.fin.member",
        teamSlug: "finance",
        role: "member",
      }),
    ]);
    expect((await as.siteAdmin.get("/v1/site/sso/mappings?providerId=nope")).status).toBe(400);
  });

  it("refuses a mapping that targets a site role (SSO6, ac-5)", async () => {
    for (const role of ["admin", "owner", "Owner", "site_admin"]) {
      const res = await as.owner.post(`/v1/site/sso/providers/${provider}/mappings`, {
        claimValue: "kobe.site.admin",
        teamId: teams.finance,
        role,
      });
      expect(res, role).toMatchObject({ status: 400, json: { code: "site_role_not_mappable" } });
    }
    expect(
      (
        await as.owner.post(`/v1/site/sso/providers/${provider}/mappings`, {
          claimValue: "kobe.x",
          teamId: teams.finance,
          role: "boss",
        })
      ).json.code,
    ).toBe("invalid_request");
    // Nor can one be written behind the routes' back: the column is the team_role enum.
    await expect(
      adminPg.query(
        `INSERT INTO sso_access_mappings (provider_id, claim_value, team_id, role)
         VALUES ($1, 'x', $2, 'admin')`,
        [provider, teams.finance],
      ),
    ).rejects.toThrow(/team_role/);
  });

  it("validates, refuses duplicates and unknown targets, audits create and delete", async () => {
    const path = `/v1/site/sso/providers/${provider}/mappings`;
    for (const claimValue of ["", " padded", "tab\tinside", "x".repeat(257)]) {
      expect(
        (await as.siteAdmin.post(path, { claimValue, teamId: teams.finance, role: "member" }))
          .status,
      ).toBe(400);
    }
    const dup = await as.siteAdmin.post(path, {
      claimValue: "kobe.fin.member",
      teamId: teams.finance,
      role: "team_admin",
    });
    expect(dup).toMatchObject({ status: 409, json: { code: "mapping_exists" } });
    expect(
      (await as.siteAdmin.post(path, { claimValue: "a", teamId: randomUUID(), role: "member" }))
        .json.code,
    ).toBe("team_not_found");
    expect(
      (
        await as.siteAdmin.post(`/v1/site/sso/providers/${randomUUID()}/mappings`, {
          claimValue: "a",
          teamId: teams.finance,
          role: "member",
        })
      ).json.code,
    ).toBe("provider_not_found");

    const seq = await lastSeq();
    const id = await map(provider, "kobe.temp", teams.marketing, "contributor");
    expect((await as.siteAdmin.delete(`${path}/${id}`)).status).toBe(204);
    expect((await as.siteAdmin.delete(`${path}/${id}`)).status).toBe(404);
    // Another provider's id never deletes this provider's mapping.
    const mine = await map(provider, "kobe.temp2", teams.marketing, "member");
    expect(
      (await as.siteAdmin.delete(`/v1/site/sso/providers/${other}/mappings/${mine}`)).status,
    ).toBe(404);
    expect((await as.siteAdmin.delete(`${path}/${mine}`)).status).toBe(204);
    const events = await auditSince(seq);
    expect(events.map((e) => e.action)).toEqual([
      "identity.sso.mapping.created",
      "identity.sso.mapping.deleted",
      "identity.sso.mapping.created",
      "identity.sso.mapping.deleted",
    ]);
    expect(events[0]).toMatchObject({
      team_id: null,
      actor_id: ids.siteAdmin,
      target: { providerId: provider, mappingId: id, teamId: teams.marketing, role: "contributor" },
    });
    expect(JSON.stringify(events)).not.toContain("kobe.temp");
  });
});

describe("applyIdpAccess rules (§7, ac-1, ac-6)", () => {
  it("refuses an unknown provider and an oversized value list", async () => {
    await expect(apply("bob", [], randomUUID())).rejects.toBeInstanceOf(UnknownProviderError);
    await expect(
      apply(
        "bob",
        Array.from({ length: 2001 }, (_, i) => `v${i}`),
      ),
    ).rejects.toThrow(/too many/);
  });

  it("rule 1-2: adds managed rows with the highest matched role per team, audited via idp", async () => {
    const seq = await lastSeq();
    const result = await apply("bob", [
      "kobe.fin.member",
      "kobe.fin.builder",
      "kobe.mkt.member",
      "unmapped.value",
    ]);
    expect(sortChanges(result)).toEqual(
      [
        { kind: "added", teamId: teams.finance, role: "contributor" },
        { kind: "added", teamId: teams.marketing, role: "member" },
      ].sort(byTeam),
    );
    expect(result.conflicts).toEqual([]);
    expect(await row(teams.finance, "bob")).toEqual({
      role: "contributor",
      added_via: `idp:${provider}`,
    });
    const added = await auditSince(seq, "identity.member.added");
    expect(added).toHaveLength(2);
    for (const e of added) {
      expect(e).toMatchObject({
        actor_kind: "system",
        target: { userId: ids.bob, via: "idp", providerId: provider },
      });
      expect(e.team_id).not.toBeNull();
    }
    // Applying the same values again changes nothing.
    expect(
      (await apply("bob", ["kobe.fin.builder", "kobe.fin.member", "kobe.mkt.member"])).changes,
    ).toEqual([]);
  });

  it("rule 2: updates a managed row's role when the mappings change it, keeping it managed", async () => {
    const seq = await lastSeq();
    const up = await apply("bob", ["kobe.fin.admin", "kobe.mkt.member"]);
    expect(up.changes).toEqual([
      { kind: "role_changed", teamId: teams.finance, from: "contributor", to: "team_admin" },
    ]);
    const down = await apply("bob", ["kobe.fin.member", "kobe.mkt.member"]);
    expect(down.changes).toEqual([
      { kind: "role_changed", teamId: teams.finance, from: "team_admin", to: "member" },
    ]);
    expect(await row(teams.finance, "bob")).toEqual({
      role: "member",
      added_via: `idp:${provider}`,
    });
    const changed = await auditSince(seq, "identity.member.role_changed");
    expect(changed.map((e) => e.target)).toEqual([
      { userId: ids.bob, from: "contributor", to: "team_admin", via: "idp", providerId: provider },
      { userId: ids.bob, from: "team_admin", to: "member", via: "idp", providerId: provider },
    ]);
  });

  it("rule 3: never changes or removes a manual row; records manual_row when it differs", async () => {
    // Alice is Finance's manual team admin (she created it): a member mapping can't demote her.
    const seq = await lastSeq();
    const result = await apply("alice", ["kobe.fin.member"]);
    expect(result.changes).toEqual([]);
    expect(result.conflicts).toEqual([{ teamId: teams.finance, reason: "manual_row" }]);
    expect(await row(teams.finance, "alice")).toEqual({ role: "team_admin", added_via: null });
    const conflicts = await auditSince(seq, "identity.sso.mapping_conflict");
    expect(conflicts).toEqual([
      expect.objectContaining({
        team_id: null,
        target: {
          providerId: provider,
          teamId: teams.finance,
          userId: ids.alice,
          reason: "manual_row",
        },
      }),
    ]);
    // Not even when the mapping would grant more; no values at all doesn't remove it either.
    await switchTo("alice", teams.marketing);
    expect(
      (await as.alice.post("/v1/team/invites", { email: email("dave"), role: "member" })).status,
    ).toBe(202);
    expect((await as.dave.post(`/v1/me/invites/${teams.marketing}/accept`)).status).toBe(200);
    const more = await apply("dave", ["kobe.mkt.member", "kobe.fin.admin"]);
    expect(more.changes).toEqual([{ kind: "added", teamId: teams.finance, role: "team_admin" }]);
    expect(await row(teams.marketing, "dave")).toEqual({ role: "member", added_via: null });
    const none = await apply("dave", []);
    expect(none.changes).toEqual([{ kind: "removed", teamId: teams.finance, role: "team_admin" }]);
    expect(await row(teams.marketing, "dave")).toEqual({ role: "member", added_via: null });
    await switchTo("alice", teams.finance);
  });

  it("leaves rows another provider manages alone", async () => {
    await apply("erin", ["kobe.fin.member"], other);
    expect(await row(teams.finance, "erin")).toEqual({ role: "member", added_via: `idp:${other}` });
    const result = await apply("erin", []);
    expect(result.changes).toEqual([]);
    expect(await row(teams.finance, "erin")).toEqual({ role: "member", added_via: `idp:${other}` });
    const higher = await apply("erin", ["kobe.fin.builder"]);
    expect(higher.conflicts).toEqual([{ teamId: teams.finance, reason: "manual_row" }]);
    expect((await apply("erin", [], other)).changes).toEqual([
      { kind: "removed", teamId: teams.finance, role: "member" },
    ]);
  });

  it("rule 2 + ac-2: a removal goes through teams/members.ts and pauses the member's schedules", async () => {
    const scheduleId = randomUUID();
    await adminPg.query(
      `INSERT INTO schedules (team_id, id, user_id, agent_id, prompt, recurrence, cron, tz, active, next_due_at)
       VALUES ($1, $2, $3, $4, 'daily report', '{"kind":"daily","time":"09:00"}', '0 9 * * *', 'UTC', true, now() + interval '1 day')`,
      [teams.marketing, scheduleId, ids.bob, randomUUID()],
    );
    const seq = await lastSeq();
    const result = await applyIdpAccessAndFollowUp(deps, {
      providerId: provider,
      userId: ids.bob,
      values: ["kobe.fin.member"],
      actor: SYSTEM,
    });
    expect(result.changes).toEqual([{ kind: "removed", teamId: teams.marketing, role: "member" }]);
    expect(await row(teams.marketing, "bob")).toBeNull();
    const { rows } = await adminPg.query<{ active: boolean; next_due_at: Date | null }>(
      `SELECT active, next_due_at FROM schedules WHERE id = $1`,
      [scheduleId],
    );
    expect(rows[0]).toEqual({ active: false, next_due_at: null });
    const events = await auditSince(seq);
    expect(events.map((e) => e.action)).toEqual(
      expect.arrayContaining(["schedule.deactivated", "identity.member.removed"]),
    );
    expect(events.find((e) => e.action === "identity.member.removed")).toMatchObject({
      team_id: teams.marketing,
      target: { userId: ids.bob, role: "member", via: "idp", providerId: provider },
    });
  });

  it("rule 4: keeps the last active team admin's managed row, records last_team_admin, retries", async () => {
    // Carol becomes Ops's team admin through the mapping; Fred (manual) then leaves.
    expect((await apply("carol", ["kobe.ops.admin"])).changes).toEqual([
      { kind: "added", teamId: teams.ops, role: "team_admin" },
    ]);
    await switchTo("fred", teams.ops);
    expect((await as.fred.delete(`/v1/team/members/${ids.fred}`)).status).toBe(204);

    const seq = await lastSeq();
    const gone = await apply("carol", []);
    expect(gone.changes).toEqual([]);
    expect(gone.conflicts).toEqual([{ teamId: teams.ops, reason: "last_team_admin" }]);
    expect(gone.memberships).toEqual([{ teamId: teams.ops, role: "team_admin" }]);
    expect(await row(teams.ops, "carol")).toEqual({
      role: "team_admin",
      added_via: `idp:${provider}`,
    });
    // A downgrade is held the same way.
    const opsMember = await map(provider, "kobe.ops.member", teams.ops, "member");
    expect((await apply("carol", ["kobe.ops.member"])).conflicts).toEqual([
      { teamId: teams.ops, reason: "last_team_admin" },
    ]);
    expect(await row(teams.ops, "carol")).toMatchObject({ role: "team_admin" });
    expect(
      (await auditSince(seq, "identity.sso.mapping_conflict")).map((e) => e.target.reason),
    ).toEqual(["last_team_admin", "last_team_admin"]);

    // Once someone else is team admin, the next apply finishes the removal.
    await apply("dave", ["kobe.ops.admin"]);
    const retried = await apply("carol", []);
    expect(retried.changes).toEqual([{ kind: "removed", teamId: teams.ops, role: "team_admin" }]);
    expect(retried.conflicts).toEqual([]);
    expect(await row(teams.ops, "carol")).toBeNull();
    expect(
      (await as.siteAdmin.delete(`/v1/site/sso/providers/${provider}/mappings/${opsMember}`))
        .status,
    ).toBe(204);
  });

  it("rule 5: no matched value removes every managed row; manual memberships stay", async () => {
    expect((await apply("carol", ["kobe.fin.member", "kobe.mkt.member"])).changes).toHaveLength(2);
    const none = await apply("carol", ["nothing.mapped"]);
    expect(none.changes.map((c) => c.kind)).toEqual(["removed", "removed"]);
    expect(none.memberships).toEqual([]);
    // Dave keeps his manual Marketing membership (and his managed Ops admin row is gone too).
    await apply("erin", ["kobe.ops.admin"]);
    const dave = await apply("dave", []);
    expect(dave.memberships).toEqual([{ teamId: teams.marketing, role: "member" }]);
  });
});

describe("managed rows in the Team console (SSO10, ac-3, ac-4)", () => {
  beforeAll(async () => {
    await apply("fred", ["kobe.fin.builder"]);
  });

  it("shows the managing provider on the roster and the team's mappings read-only", async () => {
    const roster = await as.alice.get("/v1/team/members");
    expect(roster.json.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: ids.fred,
          role: "contributor",
          addedVia: "idp",
          managedBy: { providerId: provider, providerName: "IdP entra" },
        }),
        expect.objectContaining({ userId: ids.alice, addedVia: null, managedBy: null }),
      ]),
    );
    const mappings = await as.alice.get("/v1/team/sso-mappings");
    expect(mappings.status).toBe(200);
    expect(mappings.json.mappings.map((m: { claimValue: string }) => m.claimValue).sort()).toEqual([
      "kobe.fin.admin",
      "kobe.fin.builder",
      "kobe.fin.member",
      "kobe.fin.member",
    ]);
    await switchTo("fred", teams.finance);
    expect((await as.fred.get("/v1/team/sso-mappings")).status).toBe(403);
  });

  it("refuses a team admin's role change or removal of a managed row (409)", async () => {
    const seq = await lastSeq();
    expect(await as.alice.patch(`/v1/team/members/${ids.fred}`, { role: "member" })).toMatchObject({
      status: 409,
      json: { code: "managed_by_idp" },
    });
    expect(await as.alice.delete(`/v1/team/members/${ids.fred}`)).toMatchObject({
      status: 409,
      json: { code: "managed_by_idp" },
    });
    expect(await row(teams.finance, "fred")).toEqual({
      role: "contributor",
      added_via: `idp:${provider}`,
    });
    expect(await auditSince(seq)).toEqual([]);
  });

  it("keeps a managed row managed when the person accepts an older invitation", async () => {
    await switchTo("alice", teams.marketing);
    expect(
      (await as.alice.post("/v1/team/invites", { email: email("erin"), role: "contributor" }))
        .status,
    ).toBe(202);
    await apply("erin", ["kobe.ops.admin", "kobe.mkt.member"]);
    expect((await as.erin.post(`/v1/me/invites/${teams.marketing}/accept`)).status).toBe(200);
    expect(await row(teams.marketing, "erin")).toEqual({
      role: "member",
      added_via: `idp:${provider}`,
    });
    await switchTo("alice", teams.finance);
  });

  it("Take over makes the row manual (audited); the mapping no longer touches it", async () => {
    expect((await as.fred.post(`/v1/team/members/${ids.alice}/take-over`)).status).toBe(403);
    // A manual row has nothing to take over.
    await adminPg.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
      [teams.finance, ids.siteAdmin],
    );
    expect((await as.alice.post(`/v1/team/members/${ids.siteAdmin}/take-over`)).json.code).toBe(
      "not_managed",
    );
    await adminPg.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [
      teams.finance,
      ids.siteAdmin,
    ]);
    expect((await as.alice.post(`/v1/team/members/${randomUUID()}/take-over`)).status).toBe(404);
    const seq = await lastSeq();
    const res = await as.alice.post(`/v1/team/members/${ids.fred}/take-over`);
    expect(res).toMatchObject({ status: 200, json: { userId: ids.fred, managedBy: null } });
    expect(await row(teams.finance, "fred")).toEqual({ role: "contributor", added_via: null });
    expect(await auditSince(seq)).toEqual([
      expect.objectContaining({
        action: "identity.member.taken_over",
        team_id: teams.finance,
        actor_id: ids.alice,
        target: { userId: ids.fred, providerId: provider },
      }),
    ]);
    // The mapping no longer removes or changes it; a differing desire is only a conflict.
    expect((await apply("fred", [])).changes).toEqual([]);
    expect((await apply("fred", ["kobe.fin.admin"])).conflicts).toEqual([
      { teamId: teams.finance, reason: "manual_row" },
    ]);
    expect(await row(teams.finance, "fred")).toEqual({ role: "contributor", added_via: null });
    // And the team admin may now change it.
    expect((await as.alice.patch(`/v1/team/members/${ids.fred}`, { role: "member" })).status).toBe(
      200,
    );
  });
});

describe("Take over of one's own row (review finding 4)", () => {
  it("refuses a team admin taking over their own managed row (403)", async () => {
    await switchTo("alice", teams.finance);
    await adminPg.query(
      `UPDATE team_members SET added_via = $1 WHERE team_id = $2 AND user_id = $3`,
      [`idp:${provider}`, teams.finance, ids.alice],
    );
    try {
      const res = await as.alice.post(`/v1/team/members/${ids.alice}/take-over`);
      expect(res.status).toBe(403);
      expect(res.json.code).toBe("cannot_take_over_self");
      expect((await row(teams.finance, "alice"))?.added_via).toBe(`idp:${provider}`);
    } finally {
      await adminPg.query(
        `UPDATE team_members SET added_via = NULL WHERE team_id = $1 AND user_id = $2`,
        [teams.finance, ids.alice],
      );
    }
  });
});

const byTeam = (a: { teamId: string }, b: { teamId: string }) => a.teamId.localeCompare(b.teamId);
const sortChanges = (r: IdpAccessResult) => [...r.changes].sort(byTeam);
