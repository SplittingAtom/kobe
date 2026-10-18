import { randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";
import {
  createTestDatabase,
  migrationsBefore,
  testServerUrl,
  type TestDatabase,
} from "./test-support/database.js";

/**
 * KOBE-311: the Registry, tags, installs and grants schema. A site with teams, members and skills
 * migrates as the non-superuser owner; the Default system tag and the settings row are seeded and
 * guarded; the catalog's own invariants hold in the database (the cross-team probe suite covers
 * the team tables' isolation).
 */
const MARKER = 'CREATE TYPE "public"."registry_publisher"';

let db: TestDatabase | undefined;
let oldMigrations = "";
const database = (): TestDatabase => {
  if (!db) throw new Error("database not created");
  return db;
};
const suffix = randomBytes(4).toString("hex");
const ids = { user: randomUUID(), other: randomUUID(), team: randomUUID() };

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** A statement expected to fail inside a transaction, isolated by a savepoint. */
async function refused(c: pg.Client, run: () => Promise<unknown>): Promise<unknown> {
  await c.query("SAVEPOINT attempt");
  try {
    await run();
    return null;
  } catch (err) {
    return err;
  } finally {
    await c.query("ROLLBACK TO SAVEPOINT attempt");
  }
}

/** As the app role inside a team, the way `withTeam` sets it. */
async function inTeam<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  return withClient(database().appUrl, async (c) => {
    await c.query("BEGIN");
    try {
      await c.query(`SELECT set_config('kobe.team_id', $1, true)`, [ids.team]);
      const result = await fn(c);
      await c.query("COMMIT");
      return result;
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    }
  });
}

beforeAll(async () => {
  oldMigrations = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: oldMigrations });
  await withClient(db.adminUrl, async (c) => {
    for (const [id, name] of [
      [ids.user, "User"],
      [ids.other, "Other"],
    ] as const)
      await c.query(`INSERT INTO users (id, name, email) VALUES ($1, $2, $3)`, [
        id,
        name,
        `${name.toLowerCase()}-${suffix}@example.test`,
      ]);
    await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'Registry')`, [
      ids.team,
      `registry-${suffix}`,
    ]);
    await c.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'team_admin')`,
      [ids.team, ids.user, ids.other],
    );
  });
  // As the chart's migration Job: the non-superuser owner, on a site with rows.
  await runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole });
}, 180_000);

afterAll(async () => {
  await db?.drop();
  if (oldMigrations) rmSync(oldMigrations, { recursive: true, force: true });
});

let skillId = "";
let versionId = "";
let otherSkill = "";

describe("upgrade and seeds (KOBE-311)", () => {
  it("forces RLS on the four team tables and seeds the settings row and the Default tag", async () => {
    await withClient(database().adminUrl, async (c) => {
      const forced = await c.query(
        `SELECT relname FROM pg_class WHERE relname = ANY($1) AND relrowsecurity AND relforcerowsecurity
          ORDER BY 1`,
        [
          [
            "team_skill_installs",
            "team_skill_optouts",
            "team_skill_blocks",
            "member_skill_enablements",
          ],
        ],
      );
      expect(forced.rows.map((r) => r.relname)).toEqual([
        "member_skill_enablements",
        "team_skill_blocks",
        "team_skill_installs",
        "team_skill_optouts",
      ]);
      expect((await c.query(`SELECT id, registry_team_id FROM site_skill_settings`)).rows).toEqual([
        { id: 1, registry_team_id: null },
      ]);
      expect(
        (await c.query(`SELECT name, kind::text, status::text FROM registry_tags`)).rows,
      ).toEqual([{ name: "default", kind: "system", status: "active" }]);
    });
  });
});

describe("system tags are code-defined (ac-3)", () => {
  it("refuses deleting, renaming or retiring Default, even as the owner", async () => {
    await withClient(database().ownerUrl, async (c) => {
      for (const statement of [
        `DELETE FROM registry_tags WHERE name = 'default'`,
        `UPDATE registry_tags SET name = 'defaults' WHERE name = 'default'`,
        `UPDATE registry_tags SET kind = 'topic' WHERE name = 'default'`,
        `UPDATE registry_tags SET id = gen_random_uuid() WHERE name = 'default'`,
        `TRUNCATE registry_tags CASCADE`,
      ])
        await expect(c.query(statement), statement).rejects.toMatchObject({ code: "55000" });
    });
    await withClient(database().appUrl, async (c) => {
      await expect(c.query(`DELETE FROM registry_tags`)).rejects.toMatchObject({ code: "42501" });
      await expect(
        c.query(`INSERT INTO registry_tags (name, kind) VALUES ('featured', 'system')`),
      ).rejects.toMatchObject({ constraint: "registry_tags_system_set" });
      await c.query(`INSERT INTO registry_tags (name, kind) VALUES ('finance', 'topic')`);
      await c.query(`UPDATE registry_tags SET status = 'retired' WHERE name = 'finance'`);
    });
  });
});

describe("registry invariants", () => {
  it("keeps the settings a singleton the app can only update", async () => {
    await withClient(database().appUrl, async (c) => {
      await c.query(`UPDATE site_skill_settings SET registry_team_id = $1`, [ids.team]);
      await expect(
        c.query(`INSERT INTO site_skill_settings (id) VALUES (2)`),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(c.query(`DELETE FROM site_skill_settings`)).rejects.toMatchObject({
        code: "42501",
      });
    });
  });

  it("ties a published state to its approval, and names unique per Site", async () => {
    await withClient(database().appUrl, async (c) => {
      const skill = await c.query<{ id: string }>(
        `INSERT INTO registry_skills (name, summary) VALUES ('quarterly-report', 'Q.') RETURNING id`,
      );
      skillId = skill.rows[0]?.id as string;
      await expect(
        c.query(
          `INSERT INTO registry_skills (name, summary) VALUES ('quarterly-report', 'Again.')`,
        ),
      ).rejects.toMatchObject({ constraint: "registry_skills_name_unique" });
      const insert = (state: string, approved: boolean, semver = "1.0.0") =>
        c.query<{ id: string }>(
          `INSERT INTO registry_versions (skill_id, semver, seq, runtime_hash, package_hash, manifest,
             provenance, source, scan, verdict, state, submitted_by, reviewed_by, approved_at)
           VALUES ($1, $2, 1, repeat('a', 64), repeat('b', 64), '{}', '{}', '{}', '{}', 'pass', $3,
             $4, $5, $6) RETURNING id`,
          [
            skillId,
            semver,
            state,
            ids.user,
            approved ? ids.other : null,
            approved ? new Date() : null,
          ],
        );
      await expect(insert("approved", false)).rejects.toMatchObject({
        constraint: "registry_versions_approval",
      });
      await expect(insert("in_review", true)).rejects.toMatchObject({
        constraint: "registry_versions_approval",
      });
      versionId = (await insert("approved", true)).rows[0]?.id as string;
      await expect(c.query(`DELETE FROM registry_versions`)).rejects.toMatchObject({
        code: "42501",
      });
      await c.query(
        `INSERT INTO registry_review_events (version_id, actor_id, action) VALUES ($1, $2, 'approved')`,
        [versionId, ids.other],
      );
      await expect(c.query(`UPDATE registry_review_events SET note = 'x'`)).rejects.toMatchObject({
        code: "42501",
      });
      const other = await c.query<{ id: string }>(
        `INSERT INTO registry_skills (name, summary) VALUES ('other-skill', 'O.') RETURNING id`,
      );
      otherSkill = other.rows[0]?.id as string;
    });
  });

  it("freezes a version's identity; review fields still move (S1)", async () => {
    await withClient(database().appUrl, async (c) => {
      for (const set of [
        "runtime_hash = repeat('d', 64)",
        "package_hash = repeat('d', 64)",
        "manifest = '{\"x\": 1}'",
        "provenance = '{}'::jsonb || '{\"y\": 1}'",
        "source = '{\"team\": 1}'",
        "semver = '9.9.9'",
        "submitted_by = reviewed_by",
        "state = 'in_review', approved_at = NULL, reviewed_by = NULL",
      ])
        await expect(
          c.query(`UPDATE registry_versions SET ${set} WHERE id = $1`, [versionId]),
          set,
        ).rejects.toMatchObject({ code: "55000" });
      await c.query(
        `UPDATE registry_versions SET state = 'deprecated', scorecard = '{"cases": 3}',
           scan = '{"rules": "2"}', verdict = 'caution', mirror = '{}' WHERE id = $1`,
        [versionId],
      );
      await c.query(`UPDATE registry_versions SET state = 'approved' WHERE id = $1`, [versionId]);
    });
  });

  it("installs only a version of the installed skill, inside the team", async () => {
    await inTeam(async (c) => {
      expect(
        await refused(c, () =>
          c.query(
            `INSERT INTO team_skill_installs (team_id, skill_id, version_id, pin_mode, access, installed_by)
             VALUES ($1, $2, $3, 'pinned', 'available', $4)`,
            [ids.team, otherSkill, versionId, ids.other],
          ),
        ),
      ).toMatchObject({ constraint: "team_skill_installs_version_fk" });
      await c.query(
        `INSERT INTO team_skill_installs (team_id, skill_id, version_id, pin_mode, access, origin, installed_by)
         VALUES ($1, $2, $3, 'within_major', 'default_on', 'default_tag', $4)`,
        [ids.team, skillId, versionId, ids.other],
      );
      expect(
        await refused(c, () =>
          c.query(
            `INSERT INTO team_skill_blocks (team_id, skill_id, blocked_by) VALUES ($1, $2, $3)`,
            [randomUUID(), skillId, ids.other],
          ),
        ),
      ).toMatchObject({ code: "42501" });
    });
  });

  it("names exactly one real skill per member enablement, with real versions (S2)", async () => {
    const otherTeam = randomUUID();
    const ownSkill = randomUUID();
    const foreignSkill = randomUUID();
    let otherVersion = "";
    await withClient(database().adminUrl, async (c) => {
      await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'Other')`, [
        otherTeam,
        `other-${suffix}`,
      ]);
      await c.query(
        `INSERT INTO team_skills (team_id, id, owner_user_id, slug, description)
         VALUES ($1, $2, $4, 'own', 'd'), ($3, $5, $4, 'foreign', 'd')`,
        [ids.team, ownSkill, otherTeam, ids.other, foreignSkill],
      );
      const v = await c.query<{ id: string }>(
        `INSERT INTO registry_versions (skill_id, semver, seq, runtime_hash, package_hash, manifest,
           provenance, source, scan, verdict, state, submitted_by, reviewed_by, approved_at)
         VALUES ($1, '1.0.0', 1, repeat('c', 64), repeat('c', 64), '{}', '{}', '{}', '{}', 'pass',
           'approved', $2, $3, now()) RETURNING id`,
        [otherSkill, ids.user, ids.other],
      );
      otherVersion = v.rows[0]?.id as string;
    });
    await inTeam(async (c) => {
      const add = (
        catalog: string | null,
        team: string | null,
        version: string | null,
        pin: string | null,
      ) =>
        c.query(
          `INSERT INTO member_skill_enablements (team_id, user_id, catalog_skill_id, team_skill_id,
             enabled, version_id, pin_mode) VALUES ($1, $2, $3, $4, true, $5, $6)`,
          [ids.team, ids.user, catalog, team, version, pin],
        );
      for (const [catalog, team, version, pin, expected] of [
        [null, null, null, null, { constraint: "member_skill_enablements_one_skill" }],
        [skillId, ownSkill, null, null, { constraint: "member_skill_enablements_one_skill" }],
        [skillId, null, versionId, null, { constraint: "member_skill_enablements_pin" }],
        [null, ownSkill, versionId, "pinned", { constraint: "member_skill_enablements_pin" }],
        // A version of another catalog skill, an unknown catalog skill, another team's skill.
        [
          skillId,
          null,
          otherVersion,
          "pinned",
          { constraint: "member_skill_enablements_version_fk" },
        ],
        [randomUUID(), null, null, null, { code: "23503" }],
        [null, foreignSkill, null, null, { constraint: "member_skill_enablements_team_skill_fk" }],
      ] as const)
        expect(
          await refused(c, () => add(catalog, team, version, pin)),
          JSON.stringify({ catalog, team, version }),
        ).toMatchObject(expected);
      await add(skillId, null, versionId, "pinned");
      expect(await refused(c, () => add(skillId, null, null, null))).toMatchObject({
        constraint: "member_skill_enablements_catalog_unique",
      });
      await add(null, ownSkill, null, null);
      await add(otherSkill, null, otherVersion, "latest");
    });
  });

  it("a personal toggle names the member's own personal skill, once, alone (KOBE-316)", async () => {
    const mine = randomUUID();
    const theirs = randomUUID();
    const ownTeamSkill = randomUUID();
    await withClient(database().adminUrl, async (c) => {
      await c.query(
        `INSERT INTO personal_skills (id, owner_user_id, slug, description)
         VALUES ($1, $3, 'mine-316', 'd'), ($2, $4, 'theirs-316', 'd')`,
        [mine, theirs, ids.user, ids.other],
      );
      await c.query(
        `INSERT INTO team_skills (team_id, id, owner_user_id, slug, description)
         VALUES ($1, $2, $3, 'own-316', 'd')`,
        [ids.team, ownTeamSkill, ids.other],
      );
    });
    await inTeam(async (c) => {
      const add = (personal: string, team: string | null = null, pin: string | null = null) =>
        c.query(
          `INSERT INTO member_skill_enablements (team_id, user_id, personal_skill_id, team_skill_id,
             enabled, version_id, pin_mode) VALUES ($1, $2, $3, $4, false, $5, $6)`,
          [ids.team, ids.user, personal, team, pin === null ? null : versionId, pin],
        );
      expect(await refused(c, () => add(theirs))).toMatchObject({
        constraint: "member_skill_enablements_personal_skill_fk",
      });
      expect(await refused(c, () => add(mine, ownTeamSkill))).toMatchObject({
        constraint: "member_skill_enablements_one_skill",
      });
      expect(await refused(c, () => add(mine, null, "pinned"))).toMatchObject({
        constraint: "member_skill_enablements_pin",
      });
      await add(mine);
      expect(await refused(c, () => add(mine))).toMatchObject({
        constraint: "member_skill_enablements_personal_unique",
      });
    });
    // Deleting the personal skill takes its toggles with it (cascade, as the table owner).
    await withClient(database().adminUrl, async (c) => {
      await c.query(`DELETE FROM personal_skills WHERE id = $1`, [mine]);
      const left = await c.query(
        `SELECT 1 FROM member_skill_enablements WHERE personal_skill_id = $1`,
        [mine],
      );
      expect(left.rows).toEqual([]);
    });
  });

  it("removes members' adds of a skill the team blocks, and refuses new ones (S2)", async () => {
    await inTeam(async (c) => {
      await c.query(
        `INSERT INTO team_skill_blocks (team_id, skill_id, blocked_by) VALUES ($1, $2, $3)`,
        [ids.team, otherSkill, ids.other],
      );
      const left = await c.query(
        `SELECT count(*)::int AS n FROM member_skill_enablements WHERE catalog_skill_id = $1`,
        [otherSkill],
      );
      expect(left.rows).toEqual([{ n: 0 }]);
      expect(
        await refused(c, () =>
          c.query(
            `INSERT INTO member_skill_enablements (team_id, user_id, catalog_skill_id, enabled)
             VALUES ($1, $2, $3, true)`,
            [ids.team, ids.user, otherSkill],
          ),
        ),
      ).toMatchObject({ code: "23514", message: expect.stringMatching(/blocked/) });
    });
  });

  it("drops a member's enablements with the membership", async () => {
    await withClient(database().adminUrl, async (c) => {
      await c.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [
        ids.team,
        ids.user,
      ]);
      const left = await c.query(
        `SELECT count(*)::int AS n FROM member_skill_enablements WHERE user_id = $1`,
        [ids.user],
      );
      expect(left.rows).toEqual([{ n: 0 }]);
    });
  });

  it("gives skill reviewer grants beside the role ladder", async () => {
    await withClient(database().appUrl, async (c) => {
      await c.query(
        `INSERT INTO site_grants (user_id, "grant", granted_by) VALUES ($1, 'skill_reviewer', $2)`,
        [ids.user, ids.other],
      );
      await expect(
        c.query(
          `INSERT INTO site_grants (user_id, "grant", granted_by) VALUES ($1, 'site_admin', $2)`,
          [ids.user, ids.other],
        ),
      ).rejects.toMatchObject({ code: "22P02" });
      await c.query(`DELETE FROM site_grants WHERE user_id = $1`, [ids.user]);
    });
  });

  it("leaves the Registry not ready when its team is deleted", async () => {
    await withClient(database().adminUrl, async (c) => {
      const team = randomUUID();
      await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'Gone')`, [
        team,
        `gone-${suffix}`,
      ]);
      await c.query(`UPDATE site_skill_settings SET registry_team_id = $1`, [team]);
      await c.query(`DELETE FROM teams WHERE id = $1`, [team]);
      expect((await c.query(`SELECT registry_team_id FROM site_skill_settings`)).rows).toEqual([
        { registry_team_id: null },
      ]);
    });
  });
});

describe("flagged self-approval on a single-admin Site (SK22, D10)", () => {
  const people = { sub: randomUUID(), second: randomUUID(), grantee: randomUUID() };
  let seq = 10;

  beforeAll(async () => {
    await withClient(database().adminUrl, async (c) => {
      for (const [name, id] of Object.entries(people))
        await c.query(`INSERT INTO users (id, name, email) VALUES ($1, $2, $3)`, [
          id,
          name,
          `${name}-${suffix}@example.test`,
        ]);
      await c.query(`DELETE FROM site_grants`);
      await c.query(`DELETE FROM site_roles`);
      await c.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, 'owner')`, [people.sub]);
    });
  });

  /** A version the submitter sent for review, as the app role. */
  async function submitted(c: pg.Client, submitter = people.sub): Promise<string> {
    seq += 1;
    const r = await c.query<{ id: string }>(
      `INSERT INTO registry_versions (skill_id, semver, seq, runtime_hash, package_hash, manifest,
         provenance, source, scan, verdict, state, submitted_by)
       VALUES ($1, $2, $3, repeat('f', 64), repeat('f', 64), '{}', '{}', '{}', '{}', 'pass',
         'in_review', $4) RETURNING id`,
      [skillId, `5.0.${seq}`, seq, submitter],
    );
    return r.rows[0]?.id as string;
  }
  const approve = (c: pg.Client, id: string, by: string) =>
    c.query<{ self_approved: boolean }>(
      `UPDATE registry_versions SET state = 'approved', reviewed_by = $2, approved_at = now()
        WHERE id = $1 RETURNING self_approved`,
      [id, by],
    );
  const asAdmin = (sql: string, params: unknown[] = []) =>
    withClient(database().adminUrl, (c) => c.query(sql, params));

  it("lets the sole active admin approve their own submission, flagged", async () => {
    await withClient(database().appUrl, async (c) => {
      const id = await submitted(c);
      const r = await approve(c, id, people.sub);
      expect(r.rows[0]?.self_approved).toBe(true);
    });
  });

  it("never flags a review by someone else", async () => {
    await withClient(database().appUrl, async (c) => {
      const id = await submitted(c);
      const r = await c.query<{ self_approved: boolean }>(
        `UPDATE registry_versions SET state = 'approved', reviewed_by = $2, approved_at = now(),
           self_approved = true WHERE id = $1 RETURNING self_approved`,
        [id, people.second],
      );
      expect(r.rows[0]?.self_approved).toBe(false);
    });
  });

  it("refuses self-approval while a second active admin exists, but not a deactivated one", async () => {
    await asAdmin(`INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin')`, [people.second]);
    await withClient(database().appUrl, async (c) => {
      const id = await submitted(c);
      await expect(approve(c, id, people.sub)).rejects.toMatchObject({ code: "42501" });
    });
    await asAdmin(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [people.second]);
    await withClient(database().appUrl, async (c) => {
      const id = await submitted(c);
      expect((await approve(c, id, people.sub)).rows[0]?.self_approved).toBe(true);
    });
    await asAdmin(`DELETE FROM site_roles WHERE user_id = $1`, [people.second]);
  });

  it("refuses self-approval while a skill reviewer grantee exists", async () => {
    await withClient(database().appUrl, async (c) => {
      await c.query(
        `INSERT INTO site_grants (user_id, "grant", granted_by) VALUES ($1, 'skill_reviewer', $2)`,
        [people.grantee, people.sub],
      );
      const id = await submitted(c);
      await expect(approve(c, id, people.sub)).rejects.toMatchObject({ code: "42501" });
      await c.query(`DELETE FROM site_grants WHERE user_id = $1`, [people.grantee]);
    });
  });

  it("refuses self-approval by a submitter who is not a Site admin", async () => {
    await withClient(database().appUrl, async (c) => {
      const id = await submitted(c, people.grantee);
      await expect(approve(c, id, people.grantee)).rejects.toMatchObject({ code: "42501" });
    });
  });

  it("refuses a self-review that is not an approval, and self-approved rows inserted directly", async () => {
    await withClient(database().appUrl, async (c) => {
      const id = await submitted(c);
      await expect(
        c.query(`UPDATE registry_versions SET state = 'rejected', reviewed_by = $2 WHERE id = $1`, [
          id,
          people.sub,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      await asAdmin(`INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin')`, [
        people.grantee,
      ]);
      await asAdmin(`UPDATE users SET deactivated_at = NULL WHERE id = $1`, [people.second]);
      seq += 1;
      await expect(
        c.query(
          `INSERT INTO registry_versions (skill_id, semver, seq, runtime_hash, package_hash,
             manifest, provenance, source, scan, verdict, state, submitted_by, reviewed_by,
             approved_at, self_approved)
           VALUES ($1, $2, $3, repeat('f', 64), repeat('f', 64), '{}', '{}', '{}', '{}', 'pass',
             'approved', $4, $4, now(), true)`,
          [skillId, `5.0.${seq}`, seq, people.sub],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await asAdmin(`DELETE FROM site_roles WHERE user_id = $1`, [people.grantee]);
    });
  });

  it("keeps the flag consistent with the reviewer (23514 when the guard is bypassed)", async () => {
    await withClient(database().adminUrl, async (c) => {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      seq += 1;
      await expect(
        c.query(
          `INSERT INTO registry_versions (skill_id, semver, seq, runtime_hash, package_hash,
             manifest, provenance, source, scan, verdict, state, submitted_by, reviewed_by,
             approved_at, self_approved)
           VALUES ($1, $2, $3, repeat('f', 64), repeat('f', 64), '{}', '{}', '{}', '{}', 'pass',
             'approved', $4, $4, now(), false)`,
          [skillId, `5.0.${seq}`, seq, people.sub],
        ),
      ).rejects.toMatchObject({ code: "23514", constraint: "registry_versions_review" });
      await c.query("ROLLBACK");
    });
  });

  it("freezes the reviewer, approval time and flag once approved", async () => {
    await withClient(database().appUrl, async (c) => {
      const id = await submitted(c);
      await approve(c, id, people.sub);
      for (const set of [
        "self_approved = false",
        "reviewed_by = '" + people.second + "'",
        "approved_at = now() - interval '1 day'",
      ])
        await expect(
          c.query(`UPDATE registry_versions SET ${set} WHERE id = $1`, [id]),
          set,
        ).rejects.toMatchObject({ code: "55000" });
      await c.query(`UPDATE registry_versions SET state = 'revoked' WHERE id = $1`, [id]);
      await c.query(`UPDATE registry_versions SET state = 'approved' WHERE id = $1`, [id]);
    });
  });

  it("waits for a concurrent skill reviewer grant before deciding the flag", async () => {
    const id = await withClient(database().appUrl, (c) => submitted(c));
    await withClient(database().appUrl, async (granter) => {
      await granter.query("BEGIN");
      await granter.query(
        `INSERT INTO site_grants (user_id, "grant", granted_by) VALUES ($1, 'skill_reviewer', $2)`,
        [people.grantee, people.sub],
      );
      const approval = withClient(database().appUrl, (c) => approve(c, id, people.sub));
      const outcome = approval.then(
        () => null,
        (err: unknown) => err,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      await granter.query("COMMIT");
      expect(await outcome).toMatchObject({ code: "42501" });
    });
    await asAdmin(`DELETE FROM site_grants WHERE user_id = $1`, [people.grantee]);
  });
});
