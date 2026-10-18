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
 * KOBE-317: Kobe-published catalog skills (0137, 0138). A site with catalog rows (a maintainer
 * skill, a version, a tag, an install and a Default sync) migrates as the non-superuser owner and
 * keeps them as they were; Kobe's own rows carry no person (requester NULL, marker set, CHECKs);
 * built-in names stay Kobe's; the publisher and recorded bytes are immutable.
 */
const MARKER = 'ADD COLUMN "publisher" "registry_publisher"';

let db: TestDatabase | undefined;
let oldMigrations = "";
const database = (): TestDatabase => {
  if (!db) throw new Error("database not created");
  return db;
};
const suffix = randomBytes(4).toString("hex");
const ids = {
  user: randomUUID(),
  admin: randomUUID(),
  team: randomUUID(),
  skill: randomUUID(),
  version: randomUUID(),
};
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const VERSION_COLUMNS = `skill_id, semver, seq, runtime_hash, package_hash, manifest, provenance,
  source, scan, verdict, state, approved_at`;

beforeAll(async () => {
  oldMigrations = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: oldMigrations });
  await withClient(db.adminUrl, async (c) => {
    for (const [id, name] of [
      [ids.user, "User"],
      [ids.admin, "Admin"],
    ] as const)
      await c.query(`INSERT INTO users (id, name, email) VALUES ($1, $2, $3)`, [
        id,
        name,
        `${name.toLowerCase()}-${suffix}@example.test`,
      ]);
    await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'Kobe skills')`, [
      ids.team,
      `kobe-skills-${suffix}`,
    ]);
    await c.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'team_admin')`,
      [ids.team, ids.admin],
    );
    await c.query(
      `INSERT INTO registry_skills (id, name, summary) VALUES ($1, 'quarterly-report', 'Q.')`,
      [ids.skill],
    );
    await c.query(
      `INSERT INTO registry_versions (id, ${VERSION_COLUMNS}, submitted_by, reviewed_by)
       VALUES ($1, $2, '1.0.0', 1, $3, $3, '{}', '{}', '{}', '{}', 'pass', 'approved', now(), $4, $5)`,
      [ids.version, ids.skill, HASH_A, ids.user, ids.admin],
    );
    await c.query(
      `INSERT INTO registry_skill_tags (skill_id, tag_id, added_by)
       SELECT $1, id, $2 FROM registry_tags WHERE name = 'default'`,
      [ids.skill, ids.admin],
    );
    await c.query(
      `INSERT INTO skill_default_syncs (skill_id, kind, major, version_id, requested_by)
       VALUES ($1, 'add', 1, $2, $3)`,
      [ids.skill, ids.version, ids.admin],
    );
    await c.query(
      `INSERT INTO team_skill_installs (team_id, skill_id, version_id, pin_mode, access, origin, installed_by)
       VALUES ($1, $2, $3, 'within_major', 'default_on', 'default_tag', $4)`,
      [ids.team, ids.skill, ids.version, ids.admin],
    );
  });
  // As the chart's migration Job: the non-superuser owner, on a site with rows.
  await runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole });
}, 180_000);

afterAll(async () => {
  await db?.drop();
  if (oldMigrations) rmSync(oldMigrations, { recursive: true, force: true });
});

/** As the app role inside the team, the way `withTeam` sets it. */
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

let kobeSkill = "";
let kobeVersion = "";

describe("upgrade (0137, 0138)", () => {
  it("keeps every existing catalog row as it was: a person's, publisher maintainer", async () => {
    await withClient(database().adminUrl, async (c) => {
      const v = await c.query(
        `SELECT publisher::text, submitted_by, runtime_storage_key FROM registry_versions`,
      );
      expect(v.rows).toEqual([
        { publisher: "maintainer", submitted_by: ids.user, runtime_storage_key: null },
      ]);
      for (const [table, column] of [
        ["registry_skill_tags", "added_by"],
        ["skill_default_syncs", "requested_by"],
        ["team_skill_installs", "installed_by"],
      ] as const) {
        const r = await c.query(`SELECT by_kobe, ${column} AS who FROM ${table}`);
        expect(r.rows, table).toEqual([{ by_kobe: false, who: ids.admin }]);
      }
    });
  });
});

describe("Kobe-published rows carry no person", () => {
  it("publishes a Kobe version with no submitter or reviewer, approved, with its bytes", async () => {
    await withClient(database().appUrl, async (c) => {
      const skill = await c.query<{ id: string }>(
        `INSERT INTO registry_skills (name, summary, publisher) VALUES ('pdf', 'PDFs.', 'kobe')
         RETURNING id`,
      );
      kobeSkill = skill.rows[0]?.id as string;
      const insert = (extra: string, values: string) =>
        c.query<{ id: string }>(
          `INSERT INTO registry_versions (${VERSION_COLUMNS}, publisher${extra})
           VALUES ($1, '1.0.0', 1, $2, $2, '{}', '{}', '{}', '{}', 'pass', 'approved', now(),
             'kobe'${values}) RETURNING id`,
          [kobeSkill, HASH_B],
        );
      // Bytes are required, a submitter or reviewer refused.
      await expect(insert("", "")).rejects.toMatchObject({
        constraint: "registry_versions_kobe_publisher",
      });
      await expect(
        insert(
          ", runtime_storage_key, runtime_size_bytes, submitted_by",
          `, 'k', 10, '${ids.user}'`,
        ),
      ).rejects.toMatchObject({ constraint: "registry_versions_kobe_publisher" });
      await expect(
        insert(
          ", runtime_storage_key, runtime_size_bytes, reviewed_by",
          `, 'k', 10, '${ids.admin}'`,
        ),
      ).rejects.toMatchObject({ constraint: "registry_versions_kobe_publisher" });
      await expect(insert(", runtime_storage_key", ", 'k'")).rejects.toMatchObject({
        constraint: "registry_versions_storage",
      });
      kobeVersion = (await insert(", runtime_storage_key, runtime_size_bytes", ", 'k', 10")).rows[0]
        ?.id as string;
    });
  });

  it("refuses a version without a person that is not Kobe's, and either on the other's skill", async () => {
    await withClient(database().appUrl, async (c) => {
      const insert = (skill: string, publisher: string, submitter: string | null, semver: string) =>
        c.query(
          `INSERT INTO registry_versions (${VERSION_COLUMNS}, publisher, submitted_by, reviewed_by,
             runtime_storage_key, runtime_size_bytes)
           VALUES ($1, $2, 9, $3, $3, '{}', '{}', '{}', '{}', 'pass', 'approved', now(), $4, $5,
             $6, 'k', 10)`,
          [skill, semver, HASH_A, publisher, submitter, publisher === "kobe" ? null : ids.admin],
        );
      await expect(insert(ids.skill, "maintainer", null, "2.0.0")).rejects.toMatchObject({
        constraint: "registry_versions_kobe_publisher",
      });
      // Nobody submits a version of a Kobe skill, and Kobe never publishes a maintainer's.
      await expect(insert(kobeSkill, "maintainer", ids.user, "2.0.0")).rejects.toMatchObject({
        constraint: "registry_versions_publisher_fk",
      });
      await expect(insert(ids.skill, "kobe", null, "2.0.0")).rejects.toMatchObject({
        constraint: "registry_versions_publisher_fk",
      });
    });
  });

  it("keeps built-in names Kobe's", async () => {
    await withClient(database().appUrl, async (c) => {
      await expect(
        c.query(`INSERT INTO registry_skills (name, summary) VALUES ('xlsx', 'Mine.')`),
      ).rejects.toMatchObject({ constraint: "registry_skills_kobe_names" });
      await expect(
        c.query(`UPDATE registry_skills SET publisher = 'maintainer' WHERE id = $1`, [kobeSkill]),
      ).rejects.toMatchObject({ constraint: "registry_skills_kobe_names" });
    });
  });

  it("marks Kobe's tag, sync and install rows, and nothing else may lack a person", async () => {
    await withClient(database().appUrl, async (c) => {
      const tag = `(SELECT id FROM registry_tags WHERE name = 'default')`;
      await expect(
        c.query(`INSERT INTO registry_skill_tags (skill_id, tag_id) SELECT $1, ${tag}`, [
          kobeSkill,
        ]),
      ).rejects.toMatchObject({ constraint: "registry_skill_tags_by_kobe" });
      await expect(
        c.query(
          `INSERT INTO registry_skill_tags (skill_id, tag_id, added_by, by_kobe)
           SELECT $1, ${tag}, $2, true`,
          [kobeSkill, ids.admin],
        ),
      ).rejects.toMatchObject({ constraint: "registry_skill_tags_by_kobe" });
      await c.query(
        `INSERT INTO registry_skill_tags (skill_id, tag_id, by_kobe) SELECT $1, ${tag}, true`,
        [kobeSkill],
      );
      await expect(
        c.query(
          `INSERT INTO skill_default_syncs (skill_id, kind, major, version_id) VALUES ($1, 'add', 1, $2)`,
          [kobeSkill, kobeVersion],
        ),
      ).rejects.toMatchObject({ constraint: "skill_default_syncs_by_kobe" });
      await c.query(
        `INSERT INTO skill_default_syncs (skill_id, kind, major, version_id, by_kobe)
         VALUES ($1, 'add', 1, $2, true)`,
        [kobeSkill, kobeVersion],
      );
    });
    await inTeam(async (c) => {
      const install = (byKobe: boolean) =>
        c.query(
          `INSERT INTO team_skill_installs (team_id, skill_id, version_id, pin_mode, access, origin, by_kobe)
           VALUES ($1, $2, $3, 'within_major', 'default_on', 'default_tag', $4)`,
          [ids.team, kobeSkill, kobeVersion, byKobe],
        );
      await c.query("SAVEPOINT attempt");
      await expect(install(false)).rejects.toMatchObject({
        constraint: "team_skill_installs_by_kobe",
      });
      await c.query("ROLLBACK TO SAVEPOINT attempt");
      await install(true);
    });
  });
});

describe("immutable identity (0138)", () => {
  it("freezes the publisher and recorded bytes; a missing key may be set once", async () => {
    await withClient(database().appUrl, async (c) => {
      for (const set of [
        "publisher = 'maintainer', submitted_by = '" + ids.user + "'",
        "runtime_storage_key = 'other'",
        "runtime_size_bytes = 11",
        "runtime_storage_key = NULL, runtime_size_bytes = NULL",
      ])
        await expect(
          c.query(`UPDATE registry_versions SET ${set} WHERE id = $1`, [kobeVersion]),
          set,
        ).rejects.toMatchObject({ code: "55000" });
      await c.query(
        `UPDATE registry_versions SET runtime_storage_key = 'r', runtime_size_bytes = 5 WHERE id = $1`,
        [ids.version],
      );
      await c.query(`UPDATE registry_versions SET package_storage_key = 'p' WHERE id = $1`, [
        ids.version,
      ]);
      await expect(
        c.query(`UPDATE registry_versions SET package_storage_key = 'q' WHERE id = $1`, [
          ids.version,
        ]),
      ).rejects.toMatchObject({ code: "55000" });
      // Retirement still moves (a Site admin deprecates a Kobe version).
      await c.query(`UPDATE registry_versions SET state = 'deprecated' WHERE id = $1`, [
        kobeVersion,
      ]);
    });
  });
});
