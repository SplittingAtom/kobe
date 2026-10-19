import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-331 (SK22): the Skill reviewer grant. Site admins give and take it (audited); members
 * can't. A grantee joins the Registry team as a member when granted, and every grantee joins when
 * a team becomes the Registry team (audited in that team's log). The grant opens the Registry
 * queue's reviewer actions and nothing else: not the Registry settings, not the site console; it
 * is read on every request, so taking it closes the queue at once. The site role ladder is
 * unchanged.
 */
let h: Harness;
const registry = randomUUID();
const ids = { admin: "", early: "", late: "", member: "" };
const as = {} as Record<keyof typeof ids, TestBrowser>;
const STATUS = "/v1/site/skills/registry/status";

beforeAll(async () => {
  h = await openHarness();
  ids.admin = await h.createUser("admin@reviewers.test", "admin");
  for (const who of ["early", "late", "member"] as const)
    ids[who] = await h.createUser(`${who}@reviewers.test`);
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'registry', 'Registry')`, [
    registry,
  ]);
  for (const who of Object.keys(ids) as (keyof typeof ids)[])
    as[who] = await h.signIn(`${who}@reviewers.test`);
});

afterAll(async () => {
  await h?.close();
});

const grant = (by: TestBrowser, userId: string) =>
  by.put(`/v1/site/roles/grants/${userId}/skill_reviewer`, {});
const members = async () =>
  (
    await h.admin.query<{ user_id: string; role: string }>(
      `SELECT user_id, role FROM team_members WHERE team_id = $1 ORDER BY user_id`,
      [registry],
    )
  ).rows;
const audit = async (action: string) =>
  (
    await h.admin.query<{
      team_id: string | null;
      actor_id: string;
      target: Record<string, unknown>;
    }>(`SELECT team_id, actor_id, target FROM audit_log WHERE action = $1 ORDER BY seq`, [action])
  ).rows;

describe("Skill reviewer grant (KOBE-331)", () => {
  it("is given by Site admins only, audited; a grantee joins the Registry team once it is named (ac-1)", async () => {
    expect((await grant(as.member, ids.early)).status).toBe(403);
    expect((await grant(as.admin, randomUUID())).status).toBe(404);
    expect((await as.admin.put(`/v1/site/roles/grants/${ids.early}/site_admin`, {})).status).toBe(
      400,
    );
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
    expect(await members()).toEqual([]);
    // Naming the Registry team brings the existing grantee in.
    const named = await as.admin.put("/v1/site/skills/registry/settings", {
      registryTeamId: registry,
    });
    expect(named.status, JSON.stringify(named.json)).toBe(200);
    expect(await members()).toEqual([{ user_id: ids.early, role: "member" }]);
    // A later grantee joins at once.
    await grant(as.admin, ids.late);
    expect((await members()).map((m) => m.user_id).sort()).toEqual([ids.early, ids.late].sort());
    expect(
      (await audit("identity.member.added")).map((a) => [a.team_id, a.target.userId, a.target.via]),
    ).toEqual([
      [registry, ids.early, "skill_reviewer_grant"],
      [registry, ids.late, "skill_reviewer_grant"],
    ]);
    const list = await as.admin.get("/v1/site/roles/grants");
    expect(
      (list.json.grants as { userId: string; grant: string }[]).map((g) => g.userId).sort(),
    ).toEqual([ids.early, ids.late].sort());
  });

  it("opens the queue to reviewers only, never settings or the site ladder (ac-2, ac-3)", async () => {
    expect((await as.early.get(STATUS)).json).toMatchObject({ ready: true });
    expect((await as.admin.get(STATUS)).status).toBe(200);
    expect((await as.member.get(STATUS)).status).toBe(403);
    expect((await as.early.get("/v1/site/skills/registry/settings")).status).toBe(403);
    expect(
      (await as.early.put("/v1/site/skills/registry/settings", { judgeAlias: null })).status,
    ).toBe(403);
    expect((await as.early.get("/v1/site/roles")).status).toBe(403);
    expect((await grant(as.early, ids.member)).status).toBe(403);
    const me = await as.early.get("/v1/me");
    expect(me.json.siteRole ?? me.json.site_role ?? null).toBeNull();
  });

  it("is taken by Site admins, audited, and closes the queue at once; membership stays (ac-1)", async () => {
    const taken = await as.admin.delete(`/v1/site/roles/grants/${ids.late}/skill_reviewer`);
    expect(taken.status).toBe(204);
    expect((await as.admin.delete(`/v1/site/roles/grants/${ids.late}/skill_reviewer`)).status).toBe(
      404,
    );
    expect((await as.late.get(STATUS)).status).toBe(403);
    expect(await audit("identity.site_grant.revoked")).toEqual([
      { team_id: null, actor_id: ids.admin, target: { userId: ids.late, grant: "skill_reviewer" } },
    ]);
    expect((await members()).map((m) => m.user_id)).toContain(ids.late);
  });
});
