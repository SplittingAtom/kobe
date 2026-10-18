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

  it("checks member enablements and drops them with the membership", async () => {
    await inTeam(async (c) => {
      const add = (ref: unknown, version: string | null, pin: string | null) =>
        c.query(
          `INSERT INTO member_skill_enablements (team_id, user_id, skill_ref, enabled, version_id, pin_mode)
           VALUES ($1, $2, $3, true, $4, $5)`,
          [ids.team, ids.user, JSON.stringify(ref), version, pin],
        );
      for (const [ref, version, pin, constraint] of [
        [{ kind: "personal", skillId }, null, null, "member_skill_enablements_ref"],
        [{ kind: "catalog", skillId, extra: 1 }, null, null, "member_skill_enablements_ref"],
        [{ kind: "catalog", skillId }, versionId, null, "member_skill_enablements_pin"],
        [{ kind: "team", skillId }, versionId, "pinned", "member_skill_enablements_pin"],
      ] as const)
        expect(await refused(c, () => add(ref, version, pin)), JSON.stringify(ref)).toMatchObject({
          constraint,
        });
      await add({ kind: "catalog", skillId }, versionId, "pinned");
      expect(await refused(c, () => add({ kind: "catalog", skillId }, null, null))).toMatchObject({
        constraint: "member_skill_enablements_ref_unique",
      });
      await add({ kind: "team", skillId: randomUUID() }, null, null);
    });
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
