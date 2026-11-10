import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  createTestDatabase,
  migrationsBefore,
  testServerUrl,
  type TestDatabase,
} from "@kobe/db/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listRestrictedProjects } from "./restricted-projects.js";

/**
 * `kobe projects restricted` (KOBE-587, RV2): the dry-run before the migration that drops
 * restricted visibility. It runs against a database that has not run it yet (lists every
 * restricted project of every team with its explicit members), changes nothing, and says so once
 * the migration has run.
 */
const MARKER = `ALTER TABLE "projects" DROP COLUMN "visibility"`;

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

describe("listRestrictedProjects before the migration", () => {
  let db: TestDatabase | undefined;
  let older = "";
  const teams = [randomUUID(), randomUUID()];
  const users = [randomUUID(), randomUUID(), randomUUID()];
  const closed = randomUUID();
  const elsewhere = randomUUID();
  const url = (): string => {
    if (!db) throw new Error("no database");
    return db.adminUrl;
  };

  beforeAll(async () => {
    older = migrationsBefore(MARKER);
    db = await createTestDatabase(testServerUrl(), { migrationsFolder: older });
    await withClient(url(), async (c) => {
      await c.query(
        `INSERT INTO teams (id, slug, name) VALUES ($1, 'alpha', 'Alpha'), ($2, 'beta', 'Beta')`,
        teams,
      );
      for (const [i, id] of users.entries()) {
        await c.query(`INSERT INTO users (id, name, email) VALUES ($1, $2, $3)`, [
          id,
          `User ${i}`,
          `u${i}@dry.test`,
        ]);
      }
      await c.query(
        `INSERT INTO projects (team_id, id, slug, name, visibility, created_by, archived_at)
         VALUES ($1, $3, 'closed', 'Closed', 'restricted', $5, NULL),
                ($1, $4, 'open', 'Open', 'workspace', $5, NULL),
                ($2, $6, 'old', 'Old', 'restricted', $5, now())`,
        [teams[0], teams[1], closed, randomUUID(), users[0], elsewhere],
      );
      await c.query(
        `INSERT INTO project_members (team_id, project_id, user_id, role, added_by)
         VALUES ($1, $2, $3, 'owner', $3), ($1, $2, $4, 'editor', $3), ($1, $2, $5, 'reader', $3)`,
        [teams[0], closed, users[0], users[1], users[2]],
      );
    });
  });

  afterAll(async () => {
    await db?.drop().catch(() => undefined);
    if (older) await rm(older, { recursive: true, force: true });
  });

  it("lists every restricted project of every team with its explicit members", async () => {
    const report = await withClient(url(), (c) => listRestrictedProjects(c));
    expect(report.state).toBe("pending");
    expect(report.projects).toEqual([
      {
        teamId: teams[0],
        teamSlug: "alpha",
        teamName: "Alpha",
        projectId: closed,
        projectSlug: "closed",
        projectName: "Closed",
        archived: false,
        members: [
          { userId: users[0], email: "u0@dry.test", name: "User 0", role: "owner" },
          { userId: users[1], email: "u1@dry.test", name: "User 1", role: "editor" },
          { userId: users[2], email: "u2@dry.test", name: "User 2", role: "reader" },
        ],
      },
      {
        teamId: teams[1],
        teamSlug: "beta",
        teamName: "Beta",
        projectId: elsewhere,
        projectSlug: "old",
        projectName: "Old",
        archived: true,
        members: [],
      },
    ]);
  });

  it("changes nothing", async () => {
    const counts = () =>
      withClient(url(), async (c) => {
        const { rows } = await c.query(
          `SELECT (SELECT count(*)::int FROM projects WHERE visibility = 'restricted') AS restricted,
                  (SELECT count(*)::int FROM project_members) AS members`,
        );
        return rows[0];
      });
    const before = await counts();
    await withClient(url(), (c) => listRestrictedProjects(c));
    expect(await counts()).toEqual(before);
    expect(before).toEqual({ restricted: 2, members: 3 });
  });
});

describe("listRestrictedProjects after the migration", () => {
  let db: TestDatabase | undefined;

  beforeAll(async () => {
    db = await createTestDatabase(testServerUrl());
  });

  afterAll(async () => {
    await db?.drop().catch(() => undefined);
  });

  it("reports that the migration already ran", async () => {
    if (!db) throw new Error("no database");
    const report = await withClient(db.adminUrl, (c) => listRestrictedProjects(c));
    expect(report).toEqual({ state: "migrated", projects: [] });
  });
});
