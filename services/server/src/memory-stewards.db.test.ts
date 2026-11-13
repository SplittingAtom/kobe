import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memoryStewardListSchema, memoryStewardSchema } from "@kobe/protocol";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-380 (v1.3 SMA5, SM19). Workspace memory stewards: Team admins give and take the grant to a
 * member of any role (audited in the team log); it goes with the membership; it adds
 * `team.memory.curate` and nothing else. Site memory stewards: the `memory_steward` site grant,
 * given by Site admins through the existing grant routes (audited), listed at
 * `/v1/site/memory/stewards`; it adds no site role and no Registry membership.
 */
let h: Harness;
const teamA = randomUUID();
const teamB = randomUUID();
const ids = { admin: "", contrib: "", member: "", other: "", outsider: "", site: "", plain: "" };
const as = {} as Record<keyof typeof ids, TestBrowser>;

const STEWARDS = "/v1/team/memory/stewards";
const audit = async (action: string) =>
  (
    await h.admin.query<{ team_id: string | null; actor_id: string; target: unknown }>(
      `SELECT team_id, actor_id, target FROM audit_log WHERE action = $1 ORDER BY seq`,
      [action],
    )
  ).rows;

beforeAll(async () => {
  h = await openHarness();
  ids.site = await h.createUser("site@stewards.test", "admin");
  for (const who of ["admin", "contrib", "member", "other", "outsider", "plain"] as const)
    ids[who] = await h.createUser(`${who}@stewards.test`);
  await h.admin.query(
    `INSERT INTO teams (id, slug, name) VALUES ($1, 'ws-a', 'A'), ($2, 'ws-b', 'B')`,
    [teamA, teamB],
  );
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES
       ($1, $2, 'team_admin'), ($1, $3, 'contributor'), ($1, $4, 'member'), ($1, $5, 'member'),
       ($6, $7, 'team_admin'), ($6, $3, 'member')`,
    [teamA, ids.admin, ids.contrib, ids.member, ids.other, teamB, ids.outsider],
  );
  for (const who of Object.keys(ids) as (keyof typeof ids)[]) {
    as[who] = await h.signIn(`${who}@stewards.test`);
    const team = who === "outsider" ? teamB : teamA;
    if (who === "site" || who === "plain") continue;
    await as[who].put("/v1/me/teams/active", { teamId: team });
    as[who].team = team;
  }
});

afterAll(async () => {
  await h?.close();
});

describe("Workspace memory stewards (KOBE-380)", () => {
  it("only Team admins list, give and take the grant (ac-1, ac-2)", async () => {
    for (const who of ["contrib", "member"] as const) {
      expect((await as[who].get(STEWARDS)).status).toBe(403);
      expect((await as[who].put(`${STEWARDS}/${ids.member}`, {})).status).toBe(403);
      expect((await as[who].delete(`${STEWARDS}/${ids.member}`)).status).toBe(403);
    }
    expect((await as.site.get(STEWARDS)).status).not.toBe(200);
  });

  it("makes a member of any role a steward, idempotently and audited once (ac-2)", async () => {
    const given = await as.admin.put(`${STEWARDS}/${ids.contrib}`, {});
    expect(given.status, JSON.stringify(given.json)).toBe(200);
    const steward = memoryStewardSchema.parse(given.json);
    expect(steward).toMatchObject({ user_id: ids.contrib, name: "contrib", granted_by: ids.admin });
    expect((await as.admin.put(`${STEWARDS}/${ids.contrib}`, {})).status).toBe(200);
    expect((await as.admin.put(`${STEWARDS}/${ids.member}`, {})).status).toBe(200);
    expect(await audit("memory.steward.granted")).toEqual(
      [ids.contrib, ids.member].map((userId) => ({
        team_id: teamA,
        actor_id: ids.admin,
        target: { userId },
      })),
    );
    const list = memoryStewardListSchema.parse((await as.admin.get(STEWARDS)).json);
    expect(list.level).toBe("team");
    expect(list.stewards.map((s) => s.user_id)).toEqual([ids.contrib, ids.member]);
  });

  it("refuses someone who is not a member of this Workspace (ac-2)", async () => {
    const r = await as.admin.put(`${STEWARDS}/${ids.outsider}`, {});
    expect([r.status, r.json.code]).toEqual([404, "user_not_found"]);
    expect((await as.admin.put(`${STEWARDS}/${randomUUID()}`, {})).status).toBe(404);
    expect((await as.admin.put(`${STEWARDS}/not-a-uuid`, {})).status).toBe(400);
  });

  it("stays inside the Workspace: team B sees none of team A's stewards (ac-4)", async () => {
    const list = memoryStewardListSchema.parse((await as.outsider.get(STEWARDS)).json);
    expect(list.stewards).toEqual([]);
    // The contributor of A is a plain member of B: no steward there.
    const r = await as.outsider.delete(`${STEWARDS}/${ids.contrib}`);
    expect([r.status, r.json.code]).toEqual([404, "not_found"]);
  });

  it("adds team.memory.curate and nothing else to the steward's permissions (ac-1, ac-3)", async () => {
    const contrib = (await as.contrib.get("/v1/team")).json;
    expect(contrib.role).toBe("contributor");
    expect(contrib.memorySteward).toBe(true);
    expect(contrib.permissions).toContain("team.memory.curate");
    expect(contrib.permissions).not.toContain("team.memory.manage");
    expect(contrib.permissions).not.toContain("team.memory.site_proposals.confirm");
    expect(contrib.permissions).not.toContain("team.members.manage");
    const other = (await as.other.get("/v1/team")).json;
    expect(other.memorySteward).toBe(false);
    expect(other.permissions.filter((p: string) => p.startsWith("team.memory."))).toEqual([]);
    const member = (await as.member.get("/v1/team")).json;
    expect(member.permissions.sort()).toEqual([...other.permissions, "team.memory.curate"].sort());
    // A steward still can't do what the role doesn't allow, e.g. manage members or switches.
    expect((await as.member.get(STEWARDS)).status).toBe(403);
    expect((await as.member.put(`${STEWARDS}/${ids.other}`, {})).status).toBe(403);
  });

  it("takes the grant (audited) and refuses a second take (ac-2)", async () => {
    expect((await as.admin.delete(`${STEWARDS}/${ids.member}`)).status).toBe(204);
    const again = await as.admin.delete(`${STEWARDS}/${ids.member}`);
    expect([again.status, again.json.code]).toEqual([404, "not_found"]);
    expect((await as.member.get("/v1/team")).json.memorySteward).toBe(false);
  });

  it("ends the grant with the membership, audited (ac-2)", async () => {
    expect((await as.admin.delete(`/v1/team/members/${ids.contrib}`)).status).toBe(204);
    const list = memoryStewardListSchema.parse((await as.admin.get(STEWARDS)).json);
    expect(list.stewards).toEqual([]);
    expect(await audit("memory.steward.revoked")).toEqual(
      [ids.member, ids.contrib].map((userId) => ({
        team_id: teamA,
        actor_id: ids.admin,
        target: { userId },
      })),
    );
  });
});

describe("Site memory stewards (KOBE-380)", () => {
  const grant = (by: TestBrowser, userId: string) =>
    by.put(`/v1/site/roles/grants/${userId}/memory_steward`, {});

  it("is given and taken by Site admins only, audited (ac-2)", async () => {
    expect((await grant(as.plain, ids.plain)).status).toBe(403);
    expect((await grant(as.admin, ids.plain)).status).toBe(403);
    const given = await grant(as.site, ids.plain);
    expect([given.status, given.json.changed]).toEqual([200, true]);
    expect(await audit("identity.site_grant.granted")).toEqual([
      { team_id: null, actor_id: ids.site, target: { userId: ids.plain, grant: "memory_steward" } },
    ]);
    const list = memoryStewardListSchema.parse(
      (await as.site.get("/v1/site/memory/stewards")).json,
    );
    expect(list).toMatchObject({ level: "site", stewards: [{ user_id: ids.plain }] });
    expect((await as.plain.get("/v1/site/memory/stewards")).status).toBe(403);
  });

  it("adds no site role, no site permission and no Registry membership (ac-3)", async () => {
    const me = (await as.plain.get("/v1/me")).json;
    expect(me.siteRole).toBeNull();
    expect(me.siteGrants).toEqual(["memory_steward"]);
    expect((await as.plain.get("/v1/site/roles")).status).toBe(403);
    expect((await as.plain.get("/v1/site/roles/grants")).status).toBe(403);
    expect((await as.plain.get("/v1/site/skills/registry/status")).status).toBe(403);
    const memberships = await h.admin.query(`SELECT 1 FROM team_members WHERE user_id = $1`, [
      ids.plain,
    ]);
    expect(memberships.rows).toEqual([]);
  });

  it("is taken by a Site admin, audited (ac-2)", async () => {
    expect((await as.site.delete(`/v1/site/roles/grants/${ids.plain}/memory_steward`)).status).toBe(
      204,
    );
    expect(await audit("identity.site_grant.revoked")).toEqual([
      { team_id: null, actor_id: ids.site, target: { userId: ids.plain, grant: "memory_steward" } },
    ]);
    const list = memoryStewardListSchema.parse(
      (await as.site.get("/v1/site/memory/stewards")).json,
    );
    expect(list.stewards).toEqual([]);
  });
});
