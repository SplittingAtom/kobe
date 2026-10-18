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
 * KOBE-310: a site with team and personal skill versions migrates as the non-superuser owner.
 * The versions keep their rows untouched (no package zip key: their stored zip is the whole
 * upload), the site-wide `skill_hash_checks` starts empty for the recompute to fill, and the app
 * role may only read and append it.
 */
const MARKER = 'CREATE TABLE "skill_hash_checks"';
const HASH = (n: number) => n.toString(16).padStart(64, "0");

let db: TestDatabase | undefined;
let oldMigrations = "";
const database = (): TestDatabase => {
  if (!db) throw new Error("database not created");
  return db;
};
const suffix = randomBytes(4).toString("hex");
const ids = { user: randomUUID(), team: randomUUID(), skill: randomUUID(), personal: randomUUID() };

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const COLUMNS = `version, semver, seq, frontmatter, source, content_hash, storage_key, size_bytes,
  file_count, uncompressed_bytes, uploaded_by`;
const values = (n: number) =>
  `${n}, '0.${n}.0', ${n}, '{}', 'zip', '${HASH(n)}', 'k/${n}', 10, 1, 10`;

/** Rows as the release before KOBE-310 wrote them (superuser: the old grants matrix is gone). */
async function seed(admin: pg.Client): Promise<void> {
  await admin.query(`INSERT INTO users (id, name, email) VALUES ($1, 'U', $2)`, [
    ids.user,
    `u-${suffix}@example.test`,
  ]);
  await admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'Store')`, [
    ids.team,
    `store-${suffix}`,
  ]);
  await admin.query(
    `INSERT INTO team_skills (team_id, id, owner_user_id, slug, description, latest_version)
     VALUES ($1, $2, $3, 'team-skill', 'd', 2)`,
    [ids.team, ids.skill, ids.user],
  );
  for (const n of [1, 2])
    await admin.query(
      `INSERT INTO team_skill_versions (team_id, skill_id, ${COLUMNS}) VALUES ($1, $2, ${values(n)}, $3)`,
      [ids.team, ids.skill, ids.user],
    );
  await admin.query(
    `INSERT INTO personal_skills (id, owner_user_id, slug, description, latest_version)
     VALUES ($1, $2, 'mine', 'd', 1)`,
    [ids.personal, ids.user],
  );
  await admin.query(
    `INSERT INTO personal_skill_versions (skill_id, ${COLUMNS}) VALUES ($1, ${values(3)}, $2)`,
    [ids.personal, ids.user],
  );
}

beforeAll(async () => {
  oldMigrations = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: oldMigrations });
  await withClient(db.adminUrl, seed);
  await runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole });
}, 180_000);

afterAll(async () => {
  await db?.drop();
  if (oldMigrations) rmSync(oldMigrations, { recursive: true, force: true });
});

describe("skill store upgrade (KOBE-310)", () => {
  it("keeps every existing version as it was, with no package zip key", async () => {
    await withClient(database().adminUrl, async (c) => {
      const rows = await c.query(
        `SELECT content_hash, storage_key, package_hash, package_storage_key FROM team_skill_versions
         UNION ALL
         SELECT content_hash, storage_key, package_hash, package_storage_key FROM personal_skill_versions
         ORDER BY 1`,
      );
      expect(rows.rows).toEqual(
        [1, 2, 3].map((n) => ({
          content_hash: HASH(n),
          storage_key: `k/${n}`,
          package_hash: null,
          package_storage_key: null,
        })),
      );
    });
  });

  it("adds an empty site-wide skill_hash_checks the app role may read and append only", async () => {
    const { adminUrl, appRole, appUrl } = database();
    await withClient(adminUrl, async (c) => {
      expect((await c.query(`SELECT count(*)::int AS n FROM skill_hash_checks`)).rows).toEqual([
        { n: 0 },
      ]);
      const privileges = await c.query<{ p: string }>(
        `SELECT p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p
          WHERE has_table_privilege($1, 'skill_hash_checks', p) ORDER BY 1`,
        [appRole],
      );
      expect(privileges.rows.map((r) => r.p)).toEqual(["INSERT", "SELECT"]);
    });
    await withClient(appUrl, async (c) => {
      await c.query(`INSERT INTO skill_hash_checks (stored_hash, runtime_hash) VALUES ($1, $2)`, [
        HASH(1),
        HASH(9),
      ]);
      await c.query(`INSERT INTO skill_hash_checks (stored_hash, problems) VALUES ($1, $2)`, [
        HASH(2),
        JSON.stringify(["invisible_or_bidi"]),
      ]);
      for (const [runtime, problems] of [
        [null, "[]"],
        [HASH(9), '["reserved_name_case"]'],
        ["XYZ", "[]"],
      ] as const)
        await expect(
          c.query(
            `INSERT INTO skill_hash_checks (stored_hash, runtime_hash, problems) VALUES ($1, $2, $3)`,
            [HASH(4), runtime, problems],
          ),
        ).rejects.toMatchObject({ code: "23514" });
      await expect(c.query(`DELETE FROM skill_hash_checks`)).rejects.toMatchObject({
        code: "42501",
      });
    });
  });

  it("requires a package hash wherever a package zip is stored", async () => {
    await withClient(database().adminUrl, async (c) => {
      await expect(
        c.query(
          `INSERT INTO personal_skill_versions (skill_id, ${COLUMNS}, package_storage_key)
           VALUES ($1, ${values(5)}, $2, 'p/5')`,
          [ids.personal, ids.user],
        ),
      ).rejects.toMatchObject({ constraint: "personal_skill_versions_package_storage" });
      await expect(
        c.query(
          `INSERT INTO team_skill_versions (team_id, skill_id, ${COLUMNS}, package_storage_key)
           VALUES ($1, $2, ${values(6)}, $3, 'p/6')`,
          [ids.team, ids.skill, ids.user],
        ),
      ).rejects.toMatchObject({ constraint: "team_skill_versions_package_storage" });
    });
  });
});
