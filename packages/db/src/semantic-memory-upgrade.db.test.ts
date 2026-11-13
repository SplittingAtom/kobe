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
 * KOBE-376 (v1.3 Semantic Memory SMA1): the split tables arrive empty over a populated database at
 * the previous migration. Workspace and run-record tables are team tables under RLS (the probe
 * suite and the catalog check cover them like every team table); portable and Site tables are
 * site-wide with no team_id; `statement_tsv` uses the fixed 'english' config; GIN indexes exist
 * only on the site-wide version tables; nothing is SECURITY DEFINER. Behaviour (checks, holds,
 * immutability, keys): semantic-memory.db.test.ts.
 */
const MARKER = 'CREATE TABLE "semantic_memory_items"';
const WORKSPACE = [
  "semantic_memory_items",
  "semantic_memory_item_versions",
  "run_memory_items",
  "run_portable_memory_items",
  "run_site_memory_items",
];
const PORTABLE = ["portable_memory_items", "portable_memory_item_versions"];
const SITE = ["site_memory_items", "site_memory_item_versions"];
const VERSION_TABLES = [
  "semantic_memory_item_versions",
  "portable_memory_item_versions",
  "site_memory_item_versions",
];

let db: TestDatabase | undefined;
let older = "";
const teamA = randomUUID();
const teamB = randomUUID();
const userId = randomUUID();
const threadId = randomUUID();
const runId = randomUUID();

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
    await c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'Ann', $2)`, [
      userId,
      `${userId}@example.test`,
    ]);
    await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'A'), ($3, $4, 'B')`, [
      teamA,
      `a-${teamA.slice(0, 8)}`,
      teamB,
      `b-${teamB.slice(0, 8)}`,
    ]);
    await c.query(
      `INSERT INTO threads (team_id, id, owner_user_id, title) VALUES ($1, $2, $3, 'T')`,
      [teamA, threadId, userId],
    );
    await c.query(
      `INSERT INTO runs (team_id, id, thread_id, trigger, status, started_at)
       VALUES ($1, $2, $3, 'user', 'running', now())`,
      [teamA, runId, threadId],
    );
  });
  await runMigrations({ databaseUrl: database().ownerUrl, appRole: database().appRole });
}, 180_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("semantic memory tables on upgrade (KOBE-376)", () => {
  it("arrive empty: Workspace tables under forced RLS, portable and Site tables site-wide (ac-1, ac-2)", async () => {
    await asAdmin(async (c) => {
      const { rows } = await c.query<{ name: string; rls: boolean; force: boolean; team: boolean }>(
        `SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
                EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                          AND a.attname = 'team_id' AND NOT a.attisdropped) AS team
           FROM pg_class c WHERE c.relname = ANY($1) ORDER BY 1`,
        [[...WORKSPACE, ...PORTABLE, ...SITE]],
      );
      const expected = (name: string) => {
        const team = WORKSPACE.includes(name);
        return { name, rls: team, force: team, team };
      };
      expect(rows).toEqual([...WORKSPACE, ...PORTABLE, ...SITE].sort().map(expected));
      for (const table of [...WORKSPACE, ...PORTABLE, ...SITE]) {
        const n = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
        expect(n.rows[0]?.n, table).toBe(0);
      }
    });
  });

  it("grants the app role least privilege on the site-wide tables (ac-2)", async () => {
    await asAdmin(async (c) => {
      const privileges = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"];
      const { rows } = await c.query<{ name: string; privs: string[] }>(
        `SELECT t AS name,
                array(SELECT p FROM unnest($3::text[]) p WHERE has_table_privilege($1, t, p)) AS privs
           FROM unnest($2::text[]) t ORDER BY t COLLATE "C"`,
        [database().appRole, [...PORTABLE, ...SITE], privileges],
      );
      const all = ["SELECT", "INSERT", "UPDATE", "DELETE"];
      expect(rows).toEqual([
        { name: "portable_memory_item_versions", privs: ["SELECT", "INSERT"] },
        { name: "portable_memory_items", privs: all },
        { name: "site_memory_item_versions", privs: ["SELECT", "INSERT"] },
        { name: "site_memory_items", privs: all },
      ]);
    });
  });

  it("adds no SECURITY DEFINER function and pins every new function's search_path (ac-2)", async () => {
    await asAdmin(async (c) => {
      const definers = await c.query(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')`,
      );
      expect(definers.rows).toEqual([]);
      const fns = await c.query<{ name: string; config: string[] | null }>(
        `SELECT proname AS name, proconfig AS config FROM pg_proc
          WHERE proname LIKE 'semantic_memory%' ORDER BY 1`,
      );
      const pinned = { config: ["search_path=pg_catalog, public"] };
      expect(fns.rows).toEqual([
        { name: "semantic_memory_item_versions_legal_hold_guard", ...pinned },
        { name: "semantic_memory_items_legal_hold_guard", ...pinned },
        { name: "semantic_memory_versions_immutable", ...pinned },
      ]);
    });
  });

  it("generates statement_tsv with the fixed 'english' config (ac-3)", async () => {
    await asAdmin(async (c) => {
      const { rows } = await c.query<{ table: string; expr: string; generated: string }>(
        `SELECT c.relname AS table, pg_get_expr(d.adbin, d.adrelid) AS expr, a.attgenerated AS generated
           FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attname = 'statement_tsv' AND c.relname = ANY($1) ORDER BY 1`,
        [VERSION_TABLES],
      );
      expect(rows).toEqual(
        [...VERSION_TABLES].sort().map((table) => ({
          table,
          expr: "to_tsvector('english'::regconfig, statement)",
          generated: "s",
        })),
      );
    });
  });

  it("puts GIN indexes only on the portable and Site version tables (ac-4)", async () => {
    await asAdmin(async (c) => {
      const { rows } = await c.query<{ table: string; index: string; def: string }>(
        `SELECT t.relname AS table, i.relname AS index, pg_get_indexdef(i.oid) AS def
           FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid
           JOIN pg_am am ON am.oid = i.relam
          WHERE am.amname = 'gin' AND t.relname = ANY($1) ORDER BY 1, 2`,
        [[...WORKSPACE, ...PORTABLE, ...SITE]],
      );
      expect(rows.map((r) => [r.table, r.index])).toEqual([
        ["portable_memory_item_versions", "portable_memory_item_versions_trgm_idx"],
        ["portable_memory_item_versions", "portable_memory_item_versions_tsv_idx"],
        ["site_memory_item_versions", "site_memory_item_versions_trgm_idx"],
        ["site_memory_item_versions", "site_memory_item_versions_tsv_idx"],
      ]);
      expect(rows.filter((r) => r.index.endsWith("_trgm_idx")).map((r) => r.def)).toEqual([
        expect.stringContaining("gin (statement gin_trgm_ops)"),
        expect.stringContaining("gin (statement gin_trgm_ops)"),
      ]);
      const btree = await c.query<{ index: string }>(
        `SELECT i.relname AS index FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
           JOIN pg_class t ON t.oid = x.indrelid WHERE t.relname = 'semantic_memory_items' ORDER BY 1`,
      );
      expect(btree.rows.map((r) => r.index)).toEqual([
        "semantic_memory_items_owner_idx",
        "semantic_memory_items_scope_idx",
        "semantic_memory_items_team_id_id_pk",
      ]);
    });
  });
});
