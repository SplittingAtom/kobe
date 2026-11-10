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
 * KOBE-606 as an upgrade runs it (the owner role) over a database that had the built-in web search
 * configured: `web_search_settings` and `team_web_search` are dropped with their rows, the egress
 * preset `web_search` leaves the check (no row ever carried it), and the audit history of the
 * feature stays.
 */
const MARKER = `DROP TABLE "team_web_search" CASCADE`;

let db: TestDatabase | undefined;
let older = "";
const teamId = randomUUID();
const admin = randomUUID();

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

const asAdmin = <T>(fn: (c: pg.Client) => Promise<T>) => withClient(database().adminUrl, fn);

beforeAll(async () => {
  older = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: older });
  await asAdmin(async (c) => {
    await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, $2)`, [
      teamId,
      `t${teamId.slice(0, 8)}`,
    ]);
    await c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'U', $2)`, [
      admin,
      `${admin}@upgrade.test`,
    ]);
    await c.query(
      `INSERT INTO web_search_settings (provider, sealed, key_id, hint, updated_by)
       VALUES ('brave', 'e1.kid.a.b.c', 'kid', '••••1234', $1)`,
      [admin],
    );
    await c.query(`INSERT INTO team_web_search (team_id, enabled_by) VALUES ($1, $2)`, [
      teamId,
      admin,
    ]);
    await c.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, target)
       VALUES ('user', $1, 'mcp.web_search.configured',
               '{"provider":"brave","enabled":true,"keyChanged":true}')`,
      [admin],
    );
    await c.query(
      `INSERT INTO audit_log (team_id, actor_kind, actor_id, action, target)
       VALUES ($1, 'user', $2, 'mcp.web_search.team_changed', '{"enabled":true}')`,
      [teamId, admin],
    );
  });
  await runMigrations({ databaseUrl: database().ownerUrl, appRole: database().appRole });
}, 120_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("built-in web search removed on upgrade (KOBE-606)", () => {
  it("drops web_search_settings and team_web_search", async () => {
    const { rows } = await asAdmin((c) =>
      c.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_name IN ('web_search_settings', 'team_web_search')`,
      ),
    );
    expect(rows).toEqual([]);
  });

  it("keeps the feature's audit history, with an intact hash chain", async () => {
    const { rows } = await asAdmin((c) =>
      c.query(`SELECT action FROM audit_log WHERE action LIKE 'mcp.web_search.%' ORDER BY seq`),
    );
    expect(rows.map((r) => r.action)).toEqual([
      "mcp.web_search.configured",
      "mcp.web_search.team_changed",
    ]);
    const { rows: problems } = await asAdmin((c) =>
      c.query(`SELECT problem_seq, problem FROM audit_log_chain_problem()`),
    );
    expect(problems).toEqual([{ problem_seq: null, problem: null }]);
  });

  it("drops the web_search egress preset from the check", async () => {
    const { rows } = await asAdmin((c) =>
      c.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'egress_domains_preset'`,
      ),
    );
    expect(rows[0]?.def).toContain("'git_hosts'");
    expect(rows[0]?.def).not.toContain("'web_search'");
    await expect(
      asAdmin((c) =>
        c.query(
          `INSERT INTO egress_domains (domain, preset, in_ceiling) VALUES ('api.search.example', 'web_search', true)`,
        ),
      ),
    ).rejects.toThrow(/egress_domains_preset/);
  });
});
