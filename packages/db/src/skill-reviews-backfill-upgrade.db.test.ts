import { randomUUID } from "node:crypto";
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
 * KOBE-416: 0056's backfill of review rows for team skill versions read `team_skill_versions` and
 * `team_skills`, which have FORCE RLS since 0051, as the owner role (no BYPASSRLS, no team set),
 * so on an upgrade it saw no rows and inserted nothing. A site of the release before 0056 with
 * team skill versions in two teams is upgraded as migrations run: through 0056 nothing is
 * backfilled (the bug); the full chain gives every version without a review row a pending,
 * unscanned one, leaves a review row made meanwhile untouched, puts FORCE RLS back and is
 * idempotent.
 */
const BEFORE_0056 = "Backfill (KOBE-80)";
const AFTER_0056 = 'CREATE TABLE "skill_blocklist"';
const hash = (c: string): string => c.repeat(64);

let db: TestDatabase | undefined;
const folders: string[] = [];
const ids = {
  teamA: randomUUID(),
  teamB: randomUUID(),
  user: randomUUID(),
  skillA: randomUUID(),
  skillB: randomUUID(),
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

const database = (): TestDatabase => {
  if (!db) throw new Error("database not created");
  return db;
};

interface ReviewRow {
  team_id: string;
  skill_id: string;
  version: number;
  scope: string;
  slug: string;
  content_hash: string;
  status: string;
  unscanned: boolean;
  flagged: boolean;
}

const reviews = (): Promise<ReviewRow[]> =>
  withClient(database().adminUrl, async (c) => {
    const res = await c.query<ReviewRow>(
      `SELECT team_id, skill_id, version, scope, slug, content_hash, status::text AS status,
              unscanned, flagged
         FROM team_skill_reviews ORDER BY slug, version`,
    );
    return res.rows;
  });

async function seedSkill(
  c: pg.Client,
  team: string,
  skill: string,
  slug: string,
  versions: readonly [number, string][],
): Promise<void> {
  await c.query(
    `INSERT INTO team_skills (team_id, id, owner_user_id, slug, description, latest_version)
     VALUES ($1, $2, $3, $4, 'D.', $5)`,
    [team, skill, ids.user, slug, versions.length],
  );
  for (const [version, h] of versions) {
    await c.query(
      `INSERT INTO team_skill_versions (team_id, skill_id, version, frontmatter, source,
         content_hash, storage_key, size_bytes, file_count, uncompressed_bytes, uploaded_by)
       VALUES ($1, $2, $3, '{}', 'zip', $4, 'k', 1, 1, 1, $5)`,
      [team, skill, version, h, ids.user],
    );
  }
}

beforeAll(async () => {
  const older = migrationsBefore(BEFORE_0056);
  folders.push(older);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: older });
  await withClient(db.adminUrl, async (c) => {
    await c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'U', $2)`, [
      ids.user,
      `${ids.user}@upgrade.test`,
    ]);
    for (const team of [ids.teamA, ids.teamB]) {
      await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, $2)`, [
        team,
        `t${team.slice(0, 8)}`,
      ]);
    }
    await seedSkill(c, ids.teamA, ids.skillA, "alpha", [
      [1, hash("a")],
      [2, hash("b")],
    ]);
    await seedSkill(c, ids.teamB, ids.skillB, "beta", [[1, hash("c")]]);
  });
}, 180_000);

afterAll(async () => {
  await db?.drop();
  for (const f of folders) rmSync(f, { recursive: true, force: true });
});

describe("team skill review backfill on upgrade (KOBE-416)", () => {
  it("0056 as the owner role backfills nothing (FORCE RLS hides the versions)", async () => {
    const through0056 = migrationsBefore(AFTER_0056);
    folders.push(through0056);
    const { ownerUrl, appRole } = database();
    await runMigrations({ databaseUrl: ownerUrl, appRole, migrationsFolder: through0056 });
    expect(await reviews()).toEqual([]);
  }, 180_000);

  it("gives versions without a review a pending unscanned one, keeps existing rows", async () => {
    const { ownerUrl, appRole, adminUrl } = database();
    // A review row made meanwhile (e.g. an admin decided alpha v2) must not be overwritten.
    await withClient(adminUrl, (c) =>
      c.query(
        `INSERT INTO team_skill_reviews (team_id, skill_id, version, scope, slug, content_hash,
           status, unscanned, flagged, findings, scripts, skipped, reviewed_by, reviewed_at)
         VALUES ($1, $2, 2, 'team', 'alpha', $3, 'approved', false, true, '[]', '[]', '[]', $4, now())`,
        [ids.teamA, ids.skillA, hash("b"), ids.user],
      ),
    );
    await runMigrations({ databaseUrl: ownerUrl, appRole });
    const pending = { scope: "team", status: "pending", unscanned: true, flagged: false };
    const expected = [
      {
        team_id: ids.teamA,
        skill_id: ids.skillA,
        version: 1,
        slug: "alpha",
        content_hash: hash("a"),
        ...pending,
      },
      {
        team_id: ids.teamA,
        skill_id: ids.skillA,
        version: 2,
        scope: "team",
        slug: "alpha",
        content_hash: hash("b"),
        status: "approved",
        unscanned: false,
        flagged: true,
      },
      {
        team_id: ids.teamB,
        skill_id: ids.skillB,
        version: 1,
        slug: "beta",
        content_hash: hash("c"),
        ...pending,
      },
    ];
    expect(await reviews()).toEqual(expected);

    await withClient(adminUrl, async (c) => {
      const rls = await c.query<{ relname: string; relforcerowsecurity: boolean }>(
        `SELECT relname, relforcerowsecurity FROM pg_class
          WHERE relname IN ('team_skills', 'team_skill_versions', 'team_skill_reviews')
          ORDER BY relname`,
      );
      expect(rls.rows).toEqual([
        { relname: "team_skill_reviews", relforcerowsecurity: true },
        { relname: "team_skill_versions", relforcerowsecurity: true },
        { relname: "team_skills", relforcerowsecurity: true },
      ]);
    });

    // Idempotent: running again changes nothing.
    await runMigrations({ databaseUrl: ownerUrl, appRole });
    expect(await reviews()).toEqual(expected);
  }, 180_000);
});
