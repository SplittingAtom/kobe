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
 * KOBE-308 (SK14): a site with team and personal skill versions migrates as the non-superuser
 * owner (as the chart's Job does). The FORCE-RLS team tables and the immutable version tables are
 * backfilled anyway: version n reads 0.n.0 with seq n, offered team skills get access default_on,
 * and FORCE RLS and the immutability triggers are back afterwards.
 */

const MARKER = 'ALTER TABLE "personal_skill_versions" ADD COLUMN "semver" text';
const HASH = (n: number) => n.toString(16).padStart(64, "0");

let db: TestDatabase | undefined;
let oldMigrations = "";
const database = (): TestDatabase => {
  if (!db) throw new Error("database not created");
  return db;
};
const suffix = randomBytes(4).toString("hex");
const ids = {
  user: randomUUID(),
  team: randomUUID(),
  offered: randomUUID(),
  plain: randomUUID(),
  personal: randomUUID(),
};

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const VERSION_COLUMNS = `version, frontmatter, source, content_hash, storage_key, size_bytes,
  file_count, uncompressed_bytes, uploaded_by`;
const versionValues = (n: number) =>
  `${n}, '{}', 'zip', '${HASH(n)}', 'skills/${n}.zip', 10, 1, 10`;

/** Rows as the release before KOBE-308 wrote them (superuser: the old grants matrix is gone). */
async function seed(admin: pg.Client): Promise<void> {
  await admin.query(`INSERT INTO users (id, name, email) VALUES ($1, 'U', $2)`, [
    ids.user,
    `u-${suffix}@example.test`,
  ]);
  await admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'Semver')`, [
    ids.team,
    `semver-${suffix}`,
  ]);
  await admin.query(
    `INSERT INTO team_skills (team_id, id, owner_user_id, slug, description, latest_version, offer_to_all)
     VALUES ($1, $2, $4, 'offered', 'd', 3, true), ($1, $3, $4, 'plain', 'd', 1, false)`,
    [ids.team, ids.offered, ids.plain, ids.user],
  );
  for (const n of [1, 2, 3]) {
    await admin.query(
      `INSERT INTO team_skill_versions (team_id, skill_id, ${VERSION_COLUMNS})
       VALUES ($1, $2, ${versionValues(n)}, $3)`,
      [ids.team, ids.offered, ids.user],
    );
  }
  await admin.query(
    `INSERT INTO team_skill_versions (team_id, skill_id, ${VERSION_COLUMNS})
     VALUES ($1, $2, ${versionValues(1)}, $3)`,
    [ids.team, ids.plain, ids.user],
  );
  await admin.query(
    `INSERT INTO personal_skills (id, owner_user_id, slug, description, latest_version)
     VALUES ($1, $2, 'mine', 'd', 2)`,
    [ids.personal, ids.user],
  );
  for (const n of [1, 2]) {
    await admin.query(
      `INSERT INTO personal_skill_versions (skill_id, ${VERSION_COLUMNS})
       VALUES ($1, ${versionValues(n)}, $2)`,
      [ids.personal, ids.user],
    );
  }
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

describe("skill semver upgrade (KOBE-308)", () => {
  it("numbers every existing version 0.n.0 with seq n", async () => {
    await withClient(database().adminUrl, async (c) => {
      const team = await c.query(
        `SELECT skill_id, version, semver, seq, changelog, package_hash FROM team_skill_versions
          ORDER BY skill_id = $1 DESC, version`,
        [ids.offered],
      );
      expect(team.rows).toEqual([
        ...[1, 2, 3].map((n) => ({
          skill_id: ids.offered,
          version: n,
          semver: `0.${n}.0`,
          seq: n,
          changelog: null,
          package_hash: null,
        })),
        {
          skill_id: ids.plain,
          version: 1,
          semver: "0.1.0",
          seq: 1,
          changelog: null,
          package_hash: null,
        },
      ]);
      const personal = await c.query(
        `SELECT version, semver, seq FROM personal_skill_versions ORDER BY version`,
      );
      expect(personal.rows).toEqual([
        { version: 1, semver: "0.1.0", seq: 1 },
        { version: 2, semver: "0.2.0", seq: 2 },
      ]);
    });
  });

  it("maps offer_to_all to access default_on, the rest to available, none archived", async () => {
    await withClient(database().adminUrl, async (c) => {
      const rows = await c.query(
        `SELECT slug, offer_to_all, access::text, archived_at FROM team_skills ORDER BY slug`,
      );
      expect(rows.rows).toEqual([
        { slug: "offered", offer_to_all: true, access: "default_on", archived_at: null },
        { slug: "plain", offer_to_all: false, access: "available", archived_at: null },
      ]);
    });
  });

  it("restores FORCE RLS and the immutability triggers", async () => {
    await withClient(database().adminUrl, async (c) => {
      const force = await c.query(
        `SELECT relname, relforcerowsecurity AS forced FROM pg_class
          WHERE relname IN ('team_skills', 'team_skill_versions') ORDER BY relname`,
      );
      expect(force.rows).toEqual([
        { relname: "team_skill_versions", forced: true },
        { relname: "team_skills", forced: true },
      ]);
      const triggers = await c.query(
        `SELECT tgname, tgenabled FROM pg_trigger
          WHERE tgname IN ('team_skill_versions_immutable', 'personal_skill_versions_immutable')
          ORDER BY tgname`,
      );
      expect(triggers.rows).toEqual([
        { tgname: "personal_skill_versions_immutable", tgenabled: "O" },
        { tgname: "team_skill_versions_immutable", tgenabled: "O" },
      ]);
    });
    await withClient(database().ownerUrl, async (c) => {
      await expect(
        c.query(`UPDATE personal_skill_versions SET semver = '9.9.9' WHERE skill_id = $1`, [
          ids.personal,
        ]),
      ).rejects.toMatchObject({ code: "55000" });
    });
  });

  it("requires a well-formed, unique semver and seq equal to the version on new rows", async () => {
    const insert = (c: pg.Client, n: number, semver: string | null, seq: number | null) =>
      c.query(
        `INSERT INTO personal_skill_versions (skill_id, ${VERSION_COLUMNS}, semver, seq)
         VALUES ($1, ${versionValues(n)}, $2, $3, $4)`,
        [ids.personal, ids.user, semver, seq],
      );
    await withClient(database().adminUrl, async (c) => {
      const cases: [string | null, number | null, string][] = [
        [null, 3, "personal_skill_versions_semver_format"],
        ["1.2", 3, "personal_skill_versions_semver_format"],
        ["01.0.0", 3, "personal_skill_versions_semver_format"],
        ["1.0.0-beta", 3, "personal_skill_versions_semver_format"],
        ["1.0.0", null, "personal_skill_versions_seq_matches"],
        ["1.0.0", 4, "personal_skill_versions_seq_matches"],
        ["0.2.0", 3, "personal_skill_versions_semver_unique"],
      ];
      for (const [semver, seq, constraint] of cases) {
        await expect(insert(c, 3, semver, seq)).rejects.toMatchObject({ constraint });
      }
      await insert(c, 3, "1.0.0", 3);
    });
  });
});
