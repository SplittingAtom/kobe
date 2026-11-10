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
 * KOBE-602 (egress access from the conversation, EA1/EA4) as an upgrade runs it over a populated
 * database: existing requests (pending and decided) become team-scope, not internal; existing
 * ceiling rows are not internal; the app role reads and writes the new columns under the team's
 * RLS, and an internal request must be site-scope.
 */
const MARKER = `ALTER TABLE "egress_domains" ADD COLUMN "internal"`;

let db: TestDatabase | undefined;
let older = "";
const teamId = randomUUID();
const member = randomUUID();
const admin = randomUUID();
const pendingId = randomUUID();
const decidedId = randomUUID();

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

/** The app role inside the team's context (as withTeam does), rolled back afterwards. */
async function asTeam<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  return withClient(database().appUrl, async (c) => {
    await c.query("BEGIN");
    try {
      await c.query(`SELECT set_config('kobe.team_id', $1, true)`, [teamId]);
      return await fn(c);
    } finally {
      await c.query("ROLLBACK");
    }
  });
}

beforeAll(async () => {
  older = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: older });
  await withClient(db.adminUrl, async (c) => {
    await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'eg', 'Eg')`, [teamId]);
    for (const id of [member, admin]) {
      await c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'U', $2)`, [
        id,
        `${id}@u.test`,
      ]);
    }
    await c.query(
      `INSERT INTO egress_domains (domain, in_ceiling, created_by) VALUES ('pkgs.example.com', true, $1)`,
      [admin],
    );
    await c.query(
      `INSERT INTO egress_requests (team_id, id, domain, pattern, requested_by)
       VALUES ($1, $2, 'pkgs.example.com', 'pkgs.example.com', $3)`,
      [teamId, pendingId, member],
    );
    await c.query(
      `INSERT INTO egress_requests (team_id, id, domain, pattern, requested_by, status, decided_by, decided_at)
       VALUES ($1, $2, 'a.files.example.com', '*.files.example.com', $3, 'denied', $4, now())`,
      [teamId, decidedId, member, admin],
    );
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("egress access columns on upgrade (KOBE-602)", () => {
  it("backfills team scope and no internal flag, and the app role uses the new columns", async () => {
    await runMigrations({ databaseUrl: database().ownerUrl, appRole: database().appRole });
    await asTeam(async (c) => {
      const { rows } = await c.query(
        `SELECT id, scope, internal, status FROM egress_requests ORDER BY status::text`,
      );
      expect(rows).toEqual([
        { id: decidedId, scope: "team", internal: false, status: "denied" },
        { id: pendingId, scope: "team", internal: false, status: "pending" },
      ]);
      await c.query(
        `INSERT INTO egress_requests (team_id, domain, pattern, requested_by, scope, internal)
         VALUES ($1, 'app.apps.example.com', 'app.apps.example.com', $2, 'site', true)`,
        [teamId, member],
      );
      await c.query("SAVEPOINT s");
      await expect(
        c.query(
          `INSERT INTO egress_requests (team_id, domain, pattern, requested_by, scope, internal)
           VALUES ($1, 'b.example.com', 'b.example.com', $2, 'team', true)`,
          [teamId, member],
        ),
      ).rejects.toMatchObject({ constraint: "egress_requests_internal_scope" });
      await c.query("ROLLBACK TO SAVEPOINT s");
      await expect(
        c.query(
          `INSERT INTO egress_requests (team_id, domain, pattern, requested_by, scope)
           VALUES ($1, 'c.example.com', 'c.example.com', $2, 'everyone')`,
          [teamId, member],
        ),
      ).rejects.toMatchObject({ constraint: "egress_requests_scope" });
    });
    await withClient(database().appUrl, async (c) => {
      const { rows } = await c.query(
        `SELECT domain, internal FROM egress_domains WHERE preset IS NULL`,
      );
      expect(rows).toEqual([{ domain: "pkgs.example.com", internal: false }]);
      await c.query(`UPDATE egress_domains SET internal = true WHERE domain = 'pkgs.example.com'`);
      const after = await c.query(
        `SELECT internal FROM egress_domains WHERE domain = 'pkgs.example.com'`,
      );
      expect(after.rows).toEqual([{ internal: true }]);
    });
  }, 120_000);

  it("keeps the team table's RLS: another team sees none of its requests", async () => {
    await withClient(database().appUrl, async (c) => {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('kobe.team_id', $1, true)`, [randomUUID()]);
      const { rows } = await c.query(`SELECT id FROM egress_requests`);
      expect(rows).toEqual([]);
      await c.query("ROLLBACK");
    });
  });
});
