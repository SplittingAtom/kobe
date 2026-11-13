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
 * KOBE-646 (v1.3 SMA14, Chris Q3): agent versions gain `memory` = all | notes_only | off. A site
 * with published team, personal and gallery versions migrates as the non-superuser owner (as the
 * chart's Job does): every existing version reads `all` and is otherwise unchanged, the versions
 * stay immutable, and new versions take only the three values.
 */

const MARKER = 'ALTER TABLE "team_agent_versions" ADD COLUMN "memory"';

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
  teamAgent: randomUUID(),
  personal: randomUUID(),
  gallery: randomUUID(),
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

/** Rows as the release before KOBE-646 wrote them (superuser: RLS does not get in the way). */
async function seed(c: pg.Client): Promise<void> {
  await c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'u', $2)`, [
    ids.user,
    `mem-${suffix}@example.test`,
  ]);
  await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'Mem')`, [
    ids.team,
    `mem-${suffix}`,
  ]);
  await c.query(
    `INSERT INTO team_agents (team_id, id, owner_user_id, slug, frontmatter)
     VALUES ($1, $2, $3, 'agent', '{"name": "A"}')`,
    [ids.team, ids.teamAgent, ids.user],
  );
  await c.query(
    `INSERT INTO site_agents (id, scope, owner_user_id, slug, frontmatter)
     VALUES ($1, 'personal', $2, 'mine', '{"name": "M"}'), ($3, 'gallery', NULL, 'shared', '{"name": "G"}')`,
    [ids.personal, ids.user, ids.gallery],
  );
  for (const version of [1, 2])
    await c.query(
      `INSERT INTO team_agent_versions (team_id, agent_id, version, frontmatter, prompt,
         tool_manifest, published_by, draft_revision, skill_manifest)
       VALUES ($1, $2, $3, '{"name": "A"}', 'p', '{"format": 1}', $4, $3, '{"skills": []}')`,
      [ids.team, ids.teamAgent, version, ids.user],
    );
  await c.query(
    `INSERT INTO site_agent_versions (agent_id, version, frontmatter, prompt, tool_manifest,
       published_by, draft_revision)
     VALUES ($1, 1, '{"name": "M"}', 'p', '{"format": 1}', $2, 1),
            ($3, 1, '{"name": "G"}', 'p', '{"format": 1}', NULL, 1)`,
    [ids.personal, ids.user, ids.gallery],
  );
}

const snapshot = (c: pg.Client) =>
  c.query(
    `SELECT agent_id, version, frontmatter, prompt, tool_manifest, published_by, published_at,
            draft_revision, republished_from FROM (
       SELECT agent_id, version, frontmatter, prompt, tool_manifest, published_by, published_at,
              draft_revision, republished_from FROM team_agent_versions
       UNION ALL
       SELECT agent_id, version, frontmatter, prompt, tool_manifest, published_by, published_at,
              draft_revision, republished_from FROM site_agent_versions) v
     ORDER BY agent_id, version`,
  );

let before: unknown[] = [];

beforeAll(async () => {
  oldMigrations = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: oldMigrations });
  await withClient(db.adminUrl, async (c) => {
    await seed(c);
    before = (await snapshot(c)).rows;
  });
  await runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole });
}, 180_000);

afterAll(async () => {
  await db?.drop();
  if (oldMigrations) rmSync(oldMigrations, { recursive: true, force: true });
});

describe("agent version memory setting (KOBE-646)", () => {
  it("reads every existing version as all and leaves the rest of it unchanged", async () => {
    await withClient(database().adminUrl, async (c) => {
      const team = await c.query(`SELECT version, memory FROM team_agent_versions ORDER BY 1`);
      expect(team.rows).toEqual([
        { version: 1, memory: "all" },
        { version: 2, memory: "all" },
      ]);
      const site = await c.query(
        `SELECT agent_id, memory FROM site_agent_versions ORDER BY agent_id`,
      );
      expect(site.rows.map((r: { memory: string }) => r.memory)).toEqual(["all", "all"]);
      expect((await snapshot(c)).rows).toEqual(before);
    });
  });

  it("keeps the versions immutable, the new column included", async () => {
    await withClient(database().adminUrl, async (c) => {
      for (const table of ["team_agent_versions", "site_agent_versions"])
        await expect(c.query(`UPDATE ${table} SET memory = 'off'`)).rejects.toMatchObject({
          code: "55000",
        });
    });
  });

  it("takes all, notes_only and off on new versions, nothing else", async () => {
    await withClient(database().adminUrl, async (c) => {
      const team = (version: number, memory: string) =>
        c.query(
          `INSERT INTO team_agent_versions (team_id, agent_id, version, frontmatter, prompt,
             tool_manifest, published_by, draft_revision, skill_manifest, memory)
           VALUES ($1, $2, $3, '{"name": "A"}', 'p', '{"format": 1}', $4, $3, '{"skills": []}', $5)`,
          [ids.team, ids.teamAgent, version, ids.user, memory],
        );
      const site = (version: number, memory: string) =>
        c.query(
          `INSERT INTO site_agent_versions (agent_id, version, frontmatter, prompt, tool_manifest,
             published_by, draft_revision, memory)
           VALUES ($1, $2, '{"name": "M"}', 'p', '{"format": 1}', $3, $2, $4)`,
          [ids.personal, version, ids.user, memory],
        );
      for (const bad of ["semantic_only", "ALL", ""]) {
        await expect(team(3, bad)).rejects.toMatchObject({
          constraint: "team_agent_versions_memory",
        });
        await expect(site(2, bad)).rejects.toMatchObject({
          constraint: "site_agent_versions_memory",
        });
      }
      await team(3, "notes_only");
      await team(4, "off");
      await site(2, "off");
      const { rows } = await c.query(
        `SELECT version, memory FROM team_agent_versions WHERE version > 2 ORDER BY 1`,
      );
      expect(rows).toEqual([
        { version: 3, memory: "notes_only" },
        { version: 4, memory: "off" },
      ]);
    });
  });
});
