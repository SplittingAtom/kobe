import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTeam } from "@kobe/db";
import { loadCatalogFacts } from "./runs/catalog-facts.js";
import { hashOf } from "./testing/catalog-seed.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-340 (SK31, U34): Deprecate, Withdraw, Revoke and Unrevoke. Each act's effect on new
 * installs, pins, tracking and member adds; who may act; notices in-app and by email; the audit.
 */
let h: Harness;
const NAME = "retire-me";
const OTHER = "retire-other";
let skillId = "";
let otherId = "";
const v: Record<string, string> = {};
const teams = { t1: randomUUID(), t2: randomUUID(), t3: randomUUID(), t4: randomUUID() };
const ids: Record<string, string> = {};
const as: Record<string, TestBrowser> = {};

async function user(key: string, siteRole?: "admin") {
  ids[key] = await h.createUser(`${key.toLowerCase()}@retire.test`, siteRole);
}

async function version(skill: string, name: string, semver: string, seq: number) {
  const r = await h.admin.query<{ id: string }>(
    `INSERT INTO registry_versions (skill_id, semver, seq, runtime_hash, package_hash, manifest,
       provenance, source, scan, verdict, state, submitted_by, reviewed_by, approved_at)
     VALUES ($1, $2, $3, $4, $5, '{}', '{}', '{}', '{}', 'pass', 'approved', $6, $7, now())
     RETURNING id`,
    [
      skill,
      semver,
      seq,
      hashOf(`${name}@${semver}:runtime`),
      hashOf(`${name}@${semver}:package`),
      ids.maintainer,
      ids.admin,
    ],
  );
  return r.rows[0]?.id as string;
}

async function install(team: string, semver: string, pinMode: string) {
  await h.admin.query(
    `INSERT INTO team_skill_installs (team_id, skill_id, version_id, pin_mode, access, installed_by)
     VALUES ($1, $2, $3, $4, 'default_on', $5)`,
    [team, skillId, v[semver], pinMode, ids.admin],
  );
}

beforeAll(async () => {
  h = await openHarness();
  for (const k of ["maintainer", "a1", "b1", "a2", "a3", "m4", "reviewer", "outsider"])
    await user(k);
  await user("admin", "admin");
  for (const [i, team] of Object.values(teams).entries())
    await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, $3)`, [
      team,
      `retire-${i}`,
      `Retire ${i}`,
    ]);
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'team_admin'),
       ($1, $3, 'builder'), ($4, $5, 'team_admin'), ($6, $7, 'team_admin'), ($8, $9, 'member')`,
    [teams.t1, ids.a1, ids.b1, teams.t2, ids.a2, teams.t3, ids.a3, teams.t4, ids.m4],
  );
  await h.admin.query(
    `INSERT INTO site_grants (user_id, "grant", granted_by) VALUES ($1, 'skill_reviewer', $2)`,
    [ids.reviewer, ids.admin],
  );
  const s = await h.admin.query<{ id: string }>(
    `INSERT INTO registry_skills (name, summary) VALUES ($1, 'R.'), ($2, 'O.') RETURNING id`,
    [NAME, OTHER],
  );
  skillId = s.rows[0]?.id as string;
  otherId = s.rows[1]?.id as string;
  await h.admin.query(`INSERT INTO registry_maintainers (skill_id, user_id) VALUES ($1, $2)`, [
    skillId,
    ids.maintainer,
  ]);
  for (const [i, semver] of ["1.0.0", "1.1.0", "1.2.0", "2.0.0"].entries())
    v[semver] = await version(skillId, NAME, semver, i + 1);
  await version(otherId, OTHER, "1.0.0", 1);
  // Team 1 pins 1.1.0; team 2 tracks major 1 (runs 1.2.0); team 3 tracks latest (runs 2.0.0);
  // a member of team 4 added 1.2.0 for themselves.
  await install(teams.t1, "1.1.0", "pinned");
  await install(teams.t2, "1.0.0", "within_major");
  await install(teams.t3, "1.0.0", "latest");
  await h.admin.query(
    `INSERT INTO member_skill_enablements (team_id, user_id, catalog_skill_id, enabled, version_id,
       pin_mode)
     VALUES ($1, $2, $3, true, $4, 'pinned')`,
    [teams.t4, ids.m4, skillId, v["1.2.0"]],
  );
  for (const [k, team] of [
    ["maintainer", undefined],
    ["admin", undefined],
    ["reviewer", undefined],
    ["outsider", undefined],
    ["a1", teams.t1],
    ["b1", teams.t1],
    ["a2", teams.t2],
    ["a3", teams.t3],
    ["m4", teams.t4],
  ] as const) {
    as[k] = await h.signIn(`${k.toLowerCase()}@retire.test`);
    if (team) {
      expect((await as[k].put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
      (as[k] as TestBrowser).team = team;
    }
  }
});

afterAll(async () => {
  await h?.close();
});

const act = (who: string, semver: string, what: string, body: object = {}) =>
  (as[who] as TestBrowser).post(
    `/v1/site/skills/catalog/${skillId}/versions/${semver}/${what}`,
    body,
  );

/** What a run in `team` (as `userId`) loads from the catalog. */
async function runs(team: string, user: string | undefined) {
  const userId = user as string;
  const facts = await withTeam(h.deps.database.db, team, (tx) =>
    loadCatalogFacts(tx, { teamId: team, userId, namedCatalog: [] }),
  );
  return {
    loads: facts.offered.map((r) => r.semver),
    omitted: facts.offeredOmissions.map((o) => o.reason),
  };
}

async function notices(team: string, userId: string | undefined) {
  const r = await h.admin.query<{ kind: string; skill_semver: string | null }>(
    `SELECT kind, skill_semver FROM notifications WHERE team_id = $1 AND user_id = $2
     ORDER BY created_at`,
    [team, userId],
  );
  return r.rows.map((n) => `${n.kind}${n.skill_semver ? `@${n.skill_semver}` : ""}`);
}

const audits = async (action: string) =>
  (
    await h.admin.query<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE action = $1 ORDER BY seq`,
      [action],
    )
  ).rows.map((r) => r.target);

const installsOf = async (who: string) =>
  (await (as[who] as TestBrowser).get("/v1/team/skills/installs")).json.installs as {
    name: string;
    retirement: Record<string, unknown> | null;
  }[];

describe("Deprecate (ac-1, ac-3)", () => {
  it("a maintainer deprecates a version: installers told, banner, new installs need a Team admin", async () => {
    expect((await act("outsider", "1.1.0", "deprecate")).status).toBe(403);
    expect((await act("reviewer", "1.1.0", "deprecate")).status).toBe(403);
    const r = await act("maintainer", "1.1.0", "deprecate", { note: "Use 1.2.0." });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // No counts in the answer (review M1): only that the notices went out.
    expect(r.json).toEqual({ state: "deprecated", notified: true });
    // Team 1 pins it: its admin is told; team 2 runs 1.2.0: not.
    expect(await notices(teams.t1, ids.a1)).toEqual(["skill.version.deprecated@1.1.0"]);
    expect(await notices(teams.t2, ids.a2)).toEqual([]);
    expect((await installsOf("a1"))[0]?.retirement).toMatchObject({
      kind: "deprecated",
      semver: "1.1.0",
    });
    // Existing pins keep working.
    expect((await runs(teams.t1, ids.a1)).loads).toEqual(["1.1.0"]);
    // New installs: a Builder is refused, a Team admin installs with the warning; members can't add.
    await h.admin.query(`DELETE FROM team_skill_installs WHERE team_id = $1`, [teams.t1]);
    const body = { version: "1.1.0", pinMode: "pinned", access: "available" };
    expect((await as.b1?.put(`/v1/team/skills/installs/${skillId}`, body))?.status).toBe(403);
    const admin = await as.a1?.put(`/v1/team/skills/installs/${skillId}`, body);
    expect([admin?.status, admin?.json.deprecated]).toEqual([200, true]);
    const add = await as.m4?.put(`/v1/me/skills/adds/${skillId}`, {
      version: "1.1.0",
      pinMode: "pinned",
    });
    expect([add?.status, add?.json.code]).toEqual([409, "deprecated"]);
    expect(await audits("registry.deprecated")).toEqual([
      expect.objectContaining({ semver: "1.1.0", from: "approved", name: NAME }),
    ]);
    // Once deprecated, deprecating again is refused.
    expect((await act("maintainer", "1.1.0", "deprecate")).status).toBe(409);
  });
});

describe("Withdraw (ac-1, ac-3)", () => {
  it("lists the versions to act on to maintainers and Site admins only", async () => {
    const path = `/v1/site/skills/catalog/${skillId}/versions`;
    const m = await (as.maintainer as TestBrowser).get(path);
    expect(m.json).toMatchObject({ status: "active", mayRetire: false });
    expect((m.json.versions as { semver: string; state: string }[]).map((x) => x.state)).toEqual([
      "approved",
      "approved",
      "deprecated",
      "approved",
    ]);
    expect((await (as.admin as TestBrowser).get(path)).json.mayRetire).toBe(true);
    expect((await (as.outsider as TestBrowser).get(path)).status).toBe(403);
  });

  it("Site admins only; tracking moves within range, pins keep it with a notice", async () => {
    expect((await act("maintainer", "1.2.0", "withdraw")).status).toBe(403);
    expect((await act("reviewer", "1.2.0", "withdraw")).status).toBe(403);
    h.mailer.sent.length = 0;
    const r = await act("admin", "1.2.0", "withdraw");
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // Team 2 tracked 1.2.0: it moves to the next highest approved-or-deprecated in major 1.
    expect((await runs(teams.t2, ids.a2)).loads).toEqual(["1.1.0"]);
    // The member's own pin on 1.2.0 keeps working, with "Withdrawn — choose a version".
    expect((await runs(teams.t4, ids.m4)).loads).toEqual(["1.2.0"]);
    const mine = await as.m4?.get("/v1/me/skills/adds");
    expect(mine?.json.adds[0].retirement).toMatchObject({ kind: "withdrawn", semver: "1.2.0" });
    expect(await notices(teams.t2, ids.a2)).toEqual(["skill.version.withdrawn@1.2.0"]);
    expect(await notices(teams.t4, ids.m4)).toEqual(["skill.version.withdrawn@1.2.0"]);
    // Maintainers are emailed; installers are told in-app.
    await h.mailer.settle();
    expect(h.mailer.to("maintainer@retire.test")).toHaveLength(1);
    expect(h.mailer.to("a2@retire.test")).toEqual([]);
    // No new installs or pins.
    const pin = await as.a2?.post(`/v1/team/skills/installs/${skillId}/move`, { version: "1.2.0" });
    expect([pin?.status, pin?.json.code]).toEqual([409, "not_installable"]);
  });
});

describe("Revoke and Unrevoke (ac-1, ac-3)", () => {
  it("blocklists the hash, stops it everywhere, never moves across majors, and undoes", async () => {
    h.mailer.sent.length = 0;
    expect((await act("maintainer", "2.0.0", "revoke")).status).toBe(403);
    const r = await act("admin", "2.0.0", "revoke", { note: "Leaks data." });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const listed = await h.admin.query(`SELECT 1 FROM skill_blocklist WHERE content_hash = $1`, [
      hashOf(`${NAME}@2.0.0:runtime`),
    ]);
    expect(listed.rows).toHaveLength(1);
    // Team 3 tracked latest: major 2 has nothing left, and it never drops back to major 1.
    expect(await runs(teams.t3, ids.a3)).toEqual({ loads: [], omitted: ["revoked"] });
    // An agent naming it gets it through the install: omitted the same way.
    const named = await withTeam(h.deps.database.db, teams.t3, (tx) =>
      loadCatalogFacts(tx, { teamId: teams.t3, userId: ids.a3 as string, namedCatalog: [NAME] }),
    );
    expect(named.named).toEqual([]);
    expect(named.namedOmissions).toEqual([{ name: NAME, reason: "revoked" }]);
    expect((await installsOf("a3"))[0]?.retirement).toMatchObject({
      kind: "revoked",
      semver: "1.0.0",
    });
    expect(await notices(teams.t3, ids.a3)).toEqual(["skill.version.revoked@2.0.0"]);
    // Everyone with it, in-app and email; and the maintainers.
    await h.mailer.settle();
    expect(h.mailer.to("a3@retire.test")).toHaveLength(1);
    expect(h.mailer.to("maintainer@retire.test")).toHaveLength(1);
    expect(h.mailer.to("a1@retire.test")).toEqual([]);
    expect(await audits("registry.revoked")).toEqual([
      expect.objectContaining({ semver: "2.0.0", from: "approved", blocklisted: true }),
    ]);

    const u = await act("admin", "2.0.0", "unrevoke");
    expect([u.status, u.json.state]).toEqual([200, "approved"]);
    expect(
      (
        await h.admin.query(`SELECT 1 FROM skill_blocklist WHERE content_hash = $1`, [
          hashOf(`${NAME}@2.0.0:runtime`),
        ])
      ).rows,
    ).toEqual([]);
    expect((await runs(teams.t3, ids.a3)).loads).toEqual(["2.0.0"]);
    expect(await notices(teams.t3, ids.a3)).toEqual([
      "skill.version.revoked@2.0.0",
      "skill.version.unrevoked@2.0.0",
    ]);
    expect(await audits("registry.unrevoked")).toEqual([
      expect.objectContaining({ semver: "2.0.0", to: "approved", unblocked: true }),
    ]);
    expect((await act("admin", "2.0.0", "unrevoke")).status).toBe(409);
  });

  it("returns a withdrawn version to withdrawn, and leaves a block it didn't add", async () => {
    const hash = hashOf(`${NAME}@1.2.0:runtime`);
    await h.admin.query(
      `INSERT INTO skill_blocklist (content_hash, reason, added_by) VALUES ($1, 'Earlier.', $2)`,
      [hash, ids.admin],
    );
    expect((await act("admin", "1.2.0", "revoke")).status).toBe(200);
    expect((await audits("registry.revoked")).at(-1)).toMatchObject({
      from: "withdrawn",
      blocklisted: false,
    });
    // The member's pin on it stops.
    expect(await runs(teams.t4, ids.m4)).toEqual({ loads: [], omitted: ["revoked"] });
    const u = await act("admin", "1.2.0", "unrevoke");
    expect([u.status, u.json.state]).toEqual([200, "withdrawn"]);
    const still = await h.admin.query(`SELECT 1 FROM skill_blocklist WHERE content_hash = $1`, [
      hash,
    ]);
    expect(still.rows).toHaveLength(1);
  });
});

describe("Deprecate a whole skill (ac-1)", () => {
  it("names a replacement; every installer is told; Builders can't install any version", async () => {
    const bad = await (as.maintainer as TestBrowser).post(
      `/v1/site/skills/catalog/${skillId}/deprecate`,
      { replacementId: skillId },
    );
    expect(bad.status).toBe(422);
    const r = await (as.maintainer as TestBrowser).post(
      `/v1/site/skills/catalog/${skillId}/deprecate`,
      { replacementId: otherId },
    );
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    for (const [team, who] of [
      [teams.t1, ids.a1],
      [teams.t2, ids.a2],
      [teams.t3, ids.a3],
    ] as const)
      expect((await notices(team, who as string)).at(-1)).toBe("skill.deprecated");
    expect((await installsOf("a3"))[0]?.retirement).toMatchObject({
      kind: "deprecated",
      replacement: { id: otherId, name: OTHER },
    });
    await h.admin.query(`DELETE FROM team_skill_installs WHERE team_id = $1`, [teams.t1]);
    const b = await as.b1?.put(`/v1/team/skills/installs/${skillId}`, {
      version: "2.0.0",
      pinMode: "pinned",
      access: "available",
    });
    expect(b?.status).toBe(403);
    expect(await audits("skill.catalog.deprecated")).toEqual([
      { skillId, name: NAME, replacementId: otherId },
    ]);
  });
});
