import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWithAuditContext } from "./audit/context.js";
import { acceptTeamInvite, inviteToTeam } from "./invitations/team-invites.js";
import { grantsOf } from "./skills/registry/grants.js";
import { setMemberRole } from "./teams/members.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-331 (SK22) and its review. Site admins give and take the Skill reviewer grant (audited),
 * never to themselves, another Site admin, the Owner or a deactivated account. Grantees join only
 * the dedicated Registry team (never an ordinary one), marked as added by the grant, in the same
 * transaction; taking the grant removes exactly those memberships (a prior member, one a team
 * admin changed, or one an invitation confirmed stays). The grant opens the reviewer actions of
 * the Registry queue and nothing else; it is read per request. The site role ladder is unchanged.
 */
let h: Harness;
const finance = randomUUID();
const ids = {
  admin: "",
  other: "",
  early: "",
  late: "",
  prior: "",
  invited: "",
  promoted: "",
  gone: "",
  member: "",
  fin: "",
};
const as = {} as Record<keyof typeof ids, TestBrowser>;
const STATUS = "/v1/site/skills/registry/status";
let registry = "";

beforeAll(async () => {
  h = await openHarness();
  ids.admin = await h.createUser("admin@reviewers.test", "admin");
  ids.other = await h.createUser("other@reviewers.test", "admin");
  for (const who of [
    "early",
    "late",
    "prior",
    "invited",
    "promoted",
    "gone",
    "member",
    "fin",
  ] as const)
    ids[who] = await h.createUser(`${who}@reviewers.test`);
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'finance', 'Finance')`, [
    finance,
  ]);
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'team_admin')`,
    [finance, ids.fin],
  );
  for (const who of Object.keys(ids) as (keyof typeof ids)[])
    as[who] = await h.signIn(`${who}@reviewers.test`);
});

afterAll(async () => {
  await h?.close();
});

/** Calls a store function as `userId` (the audit actor a request would name). */
const actingAs = <T>(userId: string, fn: () => Promise<T>) =>
  runWithAuditContext({ actor: { kind: "user", id: userId }, ip: null, userAgent: null }, fn);

const grant = (by: TestBrowser, userId: string) =>
  by.put(`/v1/site/roles/grants/${userId}/skill_reviewer`, {});
const take = (by: TestBrowser, userId: string) =>
  by.delete(`/v1/site/roles/grants/${userId}/skill_reviewer`);
const membersOf = async (team: string) =>
  (
    await h.admin.query<{ user_id: string; role: string; added_via: string | null }>(
      `SELECT user_id, role, added_via FROM team_members WHERE team_id = $1`,
      [team],
    )
  ).rows;
const memberOf = async (team: string, userId: string) =>
  (await membersOf(team)).find((m) => m.user_id === userId);
const audit = async (action: string) =>
  (
    await h.admin.query<{
      team_id: string | null;
      actor_id: string;
      target: Record<string, unknown>;
    }>(`SELECT team_id, actor_id, target FROM audit_log WHERE action = $1 ORDER BY seq`, [action])
  ).rows;

describe("Skill reviewer grant (KOBE-331)", () => {
  it("is given by Site admins only, never to themselves, an admin or a deactivated account (ac-1)", async () => {
    expect((await grant(as.member, ids.early)).status).toBe(403);
    expect((await grant(as.fin, ids.early)).status).toBe(403);
    expect((await grant(as.admin, randomUUID())).status).toBe(404);
    expect((await as.admin.put(`/v1/site/roles/grants/${ids.early}/site_admin`, {})).status).toBe(
      400,
    );
    for (const who of [ids.admin, ids.other]) {
      const r = await grant(as.admin, who);
      expect([r.status, r.json.code]).toEqual([400, "not_grantable"]);
    }
    await h.admin.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [ids.gone]);
    const gone = await grant(as.admin, ids.gone);
    expect([gone.status, gone.json.code]).toEqual([409, "user_deactivated"]);
    const given = await grant(as.admin, ids.early);
    expect([given.status, given.json.changed]).toEqual([200, true]);
    expect((await grant(as.admin, ids.early)).json.changed).toBe(false);
    expect(await audit("identity.site_grant.granted")).toEqual([
      {
        team_id: null,
        actor_id: ids.admin,
        target: { userId: ids.early, grant: "skill_reviewer" },
      },
    ]);
  });

  it("adds grantees only to the dedicated Registry team, marked as the grant's (ac-1, review H1)", async () => {
    // An invitation sent before the grant, accepted after it (below).
    const made = await as.admin.post("/v1/site/skills/registry/team", {
      name: "Registry",
      slug: "registry",
    });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    registry = made.json.registryTeam.id as string;
    expect(await memberOf(registry, ids.early)).toEqual({
      user_id: ids.early,
      role: "member",
      added_via: "skill_reviewer_grant",
    });
    // A prior member of the Registry team keeps their own membership.
    await h.admin.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
      [registry, ids.prior],
    );
    expect(
      await actingAs(ids.admin, () =>
        inviteToTeam(h.deps.database.db, registry, {
          email: "invited@reviewers.test",
          role: "member",
          invitedBy: ids.admin,
        }),
      ),
    ).not.toBe("already_member");
    for (const who of [ids.late, ids.prior, ids.invited, ids.promoted])
      expect((await grant(as.admin, who)).status).toBe(200);
    expect((await memberOf(registry, ids.prior))?.added_via).toBeNull();
    expect((await memberOf(registry, ids.late))?.added_via).toBe("skill_reviewer_grant");
    // Never an ordinary team.
    expect((await membersOf(finance)).map((m) => m.user_id)).toEqual([ids.fin]);
    expect(
      (await audit("identity.member.added")).every(
        (a) => a.team_id === registry && a.target.via === "skill_reviewer_grant",
      ),
    ).toBe(true);
    const list = await as.admin.get("/v1/site/roles/grants");
    expect(
      (list.json.grants as { userId: string; deactivated: boolean }[]).every((g) => !g.deactivated),
    ).toBe(true);
  });

  it("opens the queue to reviewers only, never settings, grants or the site ladder (ac-2, ac-3)", async () => {
    expect((await as.early.get(STATUS)).json).toMatchObject({ ready: true });
    expect((await as.admin.get(STATUS)).status).toBe(200);
    expect((await as.member.get(STATUS)).status).toBe(403);
    expect((await as.fin.get(STATUS)).status).toBe(403);
    expect((await as.early.get("/v1/site/skills/registry/settings")).status).toBe(403);
    expect(
      (await as.early.put("/v1/site/skills/registry/settings", { judgeAlias: null })).status,
    ).toBe(403);
    expect((await as.early.get("/v1/site/roles")).status).toBe(403);
    expect((await as.early.get("/v1/site/roles/grants")).status).toBe(403);
    expect((await grant(as.early, ids.member)).status).toBe(403);
    expect((await grant(as.early, ids.early)).status).toBe(403);
    expect((await take(as.early, ids.late)).status).toBe(403);
    expect((await take(as.fin, ids.late)).status).toBe(403);
  });

  it("is promoted away and back: a demoted admin keeps only the reviewer actions", async () => {
    await h.admin.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin')`, [
      ids.promoted,
    ]);
    const asAdmin = await h.signIn("promoted@reviewers.test");
    expect((await asAdmin.get("/v1/site/skills/registry/settings")).status).toBe(200);
    await h.admin.query(`DELETE FROM site_roles WHERE user_id = $1`, [ids.promoted]);
    const asUser = await h.signIn("promoted@reviewers.test");
    expect((await asUser.get(STATUS)).status).toBe(200);
    expect((await asUser.get("/v1/site/skills/registry/settings")).status).toBe(403);
  });

  it("counts for nothing on a deactivated account", async () => {
    await h.admin.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [ids.promoted]);
    expect(await grantsOf(h.deps.database.db, ids.promoted)).toEqual([]);
    const list = await as.admin.get("/v1/site/roles/grants");
    expect(
      (list.json.grants as { userId: string; deactivated: boolean }[]).find(
        (g) => g.userId === ids.promoted,
      )?.deactivated,
    ).toBe(true);
    await h.admin.query(`UPDATE users SET deactivated_at = NULL WHERE id = $1`, [ids.promoted]);
  });

  it("is taken with exactly the memberships it made (ac-1, coordinator decision)", async () => {
    // A team admin's change, and an accepted invitation, make the membership the team's own.
    expect(
      (
        await actingAs(ids.admin, () =>
          setMemberRole(h.deps.database.db, registry, ids.early, "builder"),
        )
      ).ok,
    ).toBe(true);
    expect(
      await actingAs(ids.invited, () =>
        acceptTeamInvite(h.deps.database.db, registry, {
          id: ids.invited,
          email: "invited@reviewers.test",
        }),
      ),
    ).toBe("member");
    expect((await memberOf(registry, ids.invited))?.added_via).toBeNull();

    for (const who of [ids.late, ids.prior, ids.early, ids.invited])
      expect((await take(as.admin, who)).status).toBe(204);
    expect((await take(as.admin, ids.late)).status).toBe(404);
    const unknown = await take(as.admin, randomUUID());
    expect([unknown.status, unknown.json.code]).toEqual([404, "user_not_found"]);
    expect((await as.late.get(STATUS)).status).toBe(403);

    expect(await memberOf(registry, ids.late)).toBeUndefined();
    expect(await memberOf(registry, ids.prior)).toMatchObject({ role: "member" });
    expect(await memberOf(registry, ids.early)).toMatchObject({ role: "builder" });
    expect(await memberOf(registry, ids.invited)).toMatchObject({ role: "member" });
    expect(
      (await audit("identity.member.removed")).map((a) => [
        a.team_id,
        a.target.userId,
        a.target.via,
      ]),
    ).toEqual([[registry, ids.late, "skill_reviewer_grant"]]);
    expect((await audit("identity.site_grant.revoked")).map((a) => a.target.userId)).toEqual([
      ids.late,
      ids.prior,
      ids.early,
      ids.invited,
    ]);
  });
});
