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

  it("refuses a review by the submitter (S3)", async () => {
    await withClient(database().appUrl, async (c) => {
      await expect(
        c.query(
          `INSERT INTO registry_versions (skill_id, semver, seq, runtime_hash, package_hash, manifest,
             provenance, source, scan, verdict, state, submitted_by, reviewed_by, approved_at)
           VALUES ($1, '3.0.0', 3, repeat('e', 64), repeat('e', 64), '{}', '{}', '{}', '{}', 'pass',
             'approved', $2, $2, now())`,
          [skillId, ids.user],
        ),
      ).rejects.toMatchObject({ constraint: "registry_versions_review" });
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
