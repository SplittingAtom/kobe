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
 * the previous migration. Workspace tables are team tables under RLS (the probe suite and the
 * catalog check cover them like every team table); portable and Site tables are site-wide with no
 * team_id; checks hold the kinds, Policy and the 500-character statement; `statement_tsv` uses the
 * fixed 'english' config; GIN indexes exist only on the site-wide version tables; versions are
 * immutable; nothing is SECURITY DEFINER.
 */
const MARKER = 'CREATE TABLE "semantic_memory_items"';
const WORKSPACE = ["semantic_memory_items", "semantic_memory_item_versions", "run_memory_items"];
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

/** Runs `fn` as the app role inside a transaction with `kobe.team_id` set, as withTeam() does. */
const asAppInTeam = <T>(teamId: string, fn: (c: pg.Client) => Promise<T>) =>
  withClient(database().appUrl, async (c) => {
    await c.query("BEGIN");
    try {
      await c.query(`SELECT set_config('kobe.team_id', $1, true)`, [teamId]);
      const result = await fn(c);
      await c.query("COMMIT");
      return result;
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    }
  });

/** The SQLSTATE `sql` fails with, inside a savepoint so the caller's transaction survives. */
async function code(
  c: pg.Client,
  sql: string,
  params: unknown[] = [],
): Promise<string | undefined> {
  await c.query("SAVEPOINT probe");
  try {
    await c.query(sql, params);
    await c.query("RELEASE SAVEPOINT probe");
    return undefined;
  } catch (err) {
    await c.query("ROLLBACK TO SAVEPOINT probe");
    return (err as { code?: string }).code;
  }
}

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

  it("adds no SECURITY DEFINER function and pins the trigger's search_path (ac-2)", async () => {
    await asAdmin(async (c) => {
      const definers = await c.query(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')`,
      );
      expect(definers.rows).toEqual([]);
      const fn = await c.query<{ config: string[] | null }>(
        `SELECT proconfig AS config FROM pg_proc WHERE proname = 'semantic_memory_versions_immutable'`,
      );
      expect(fn.rows).toEqual([{ config: ["search_path=pg_catalog, public"] }]);
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

describe("semantic memory checks as the app role (ac-3)", () => {
  const long = "x".repeat(501);
  const max = "y".repeat(500);

  it("refuses a portable item that is not a preference", async () => {
    await asAppInTeam(teamA, async (c) => {
      const insert = `INSERT INTO portable_memory_items (owner_user_id, kind) VALUES ($1, $2)`;
      expect(await code(c, insert, [userId, "preference"])).toBeUndefined();
      for (const kind of ["fact", "convention", "definition", "decision", "policy"]) {
        expect(await code(c, insert, [userId, kind]), kind).toBe("23514");
      }
    });
  });

  it("keeps Policy in the Site table only", async () => {
    await asAppInTeam(teamA, async (c) => {
      expect(
        await code(c, `INSERT INTO site_memory_items (kind, policy) VALUES ('convention', true)`),
      ).toBeUndefined();
      // No policy column outside the Site table (42703), and no 'policy' kind anywhere (23514).
      expect(
        await code(
          c,
          `INSERT INTO semantic_memory_items (team_id, scope, kind, policy) VALUES ($1, 'team', 'fact', true)`,
          [teamA],
        ),
      ).toBe("42703");
      expect(
        await code(
          c,
          `INSERT INTO portable_memory_items (owner_user_id, kind, policy) VALUES ($1, 'preference', true)`,
          [userId],
        ),
      ).toBe("42703");
      expect(
        await code(
          c,
          `INSERT INTO semantic_memory_items (team_id, scope, kind) VALUES ($1, 'team', 'policy')`,
          [teamA],
        ),
      ).toBe("23514");
      expect(await code(c, `INSERT INTO site_memory_items (kind) VALUES ('policy')`)).toBe("23514");
    });
  });

  it("refuses statements over 500 characters in every version table", async () => {
    await asAppInTeam(teamA, async (c) => {
      const [ws] = (
        await c.query<{ id: string }>(
          `INSERT INTO semantic_memory_items (team_id, scope, kind) VALUES ($1, 'team', 'fact') RETURNING id`,
          [teamA],
        )
      ).rows;
      const [pt] = (
        await c.query<{ id: string }>(
          `INSERT INTO portable_memory_items (owner_user_id, kind) VALUES ($1, 'preference') RETURNING id`,
          [userId],
        )
      ).rows;
      const [st] = (
        await c.query<{ id: string }>(
          `INSERT INTO site_memory_items (kind) VALUES ('fact') RETURNING id`,
        )
      ).rows;
      const inserts: [string, unknown[]][] = [
        [
          `INSERT INTO semantic_memory_item_versions (team_id, item_id, version, statement, actor_kind, actor_user_id)
           VALUES ($1, $2, $3, $4, 'user', $5)`,
          [teamA, ws?.id],
        ],
        [
          `INSERT INTO portable_memory_item_versions (item_id, version, statement, actor_kind, actor_user_id)
           VALUES ($1, $2, $3, 'user', $4)`,
          [pt?.id],
        ],
        [
          `INSERT INTO site_memory_item_versions (item_id, version, statement, actor_kind, actor_user_id)
           VALUES ($1, $2, $3, 'user', $4)`,
          [st?.id],
        ],
      ];
      for (const [sql, keys] of inserts) {
        expect(await code(c, sql, [...keys, 1, long, userId]), sql).toBe("23514");
        expect(await code(c, sql, [...keys, 1, "   ", userId]), sql).toBe("23514");
        expect(await code(c, sql, [...keys, 1, max, userId]), sql).toBeUndefined();
      }
      const stemmed = await c.query<{ tsv: string }>(
        `INSERT INTO site_memory_item_versions (item_id, version, statement, actor_kind, actor_user_id)
         VALUES ($1, 2, 'Running the weekly reports', 'user', $2) RETURNING statement_tsv::text AS tsv`,
        [st?.id, userId],
      );
      expect(stemmed.rows).toEqual([{ tsv: "'report':4 'run':1 'week':3" }]);
    });
  });

  it("holds scope, owner, supersession, tags and provenance rules", async () => {
    await asAppInTeam(teamA, async (c) => {
      const ws = `INSERT INTO semantic_memory_items (team_id, scope, owner_user_id, kind, tags) VALUES ($1, $2, $3, 'fact', $4)`;
      expect(await code(c, ws, [teamA, "user", userId, ["a", "b"]])).toBeUndefined();
      expect(await code(c, ws, [teamA, "user", null, []])).toBe("23514");
      expect(await code(c, ws, [teamA, "team", userId, []])).toBe("23514");
      expect(await code(c, ws, [teamA, "portable", userId, []])).toBe("23514");
      expect(await code(c, ws, [teamA, "site", null, []])).toBe("23514");
      expect(await code(c, ws, [teamA, "user", userId, ["1", "2", "3", "4", "5", "6"]])).toBe(
        "23514",
      );
      expect(await code(c, ws, [teamA, "user", userId, [""]])).toBe("23514");
      expect(
        await code(
          c,
          `INSERT INTO semantic_memory_items (team_id, scope, kind, status) VALUES ($1, 'team', 'fact', 'superseded')`,
          [teamA],
        ),
      ).toBe("23514");
      const [item] = (
        await c.query<{ id: string }>(
          `INSERT INTO semantic_memory_items (team_id, scope, kind, as_of) VALUES ($1, 'team', 'decision', '2026-10-01') RETURNING id`,
          [teamA],
        )
      ).rows;
      const version = `INSERT INTO semantic_memory_item_versions
          (team_id, item_id, version, statement, actor_kind, actor_user_id, pass_id, source_thread_id, source_entry_ids, evidence)
          VALUES ($1, $2, $3, 'We ship on Tuesdays', $4, $5, $6, $7, $8, $9)`;
      const v = (
        n: number,
        kind: string,
        pass: string | null,
        thread: string | null,
        entries: string[] | null,
        ev: string | null,
      ) => code(c, version, [teamA, item?.id, n, kind, userId, pass, thread, entries, ev]);
      expect(await v(1, "pass", randomUUID(), threadId, ["e1"], `[{"quote":"q"}]`)).toBeUndefined();
      expect(await v(2, "pass", null, null, null, null)).toBe("23514");
      expect(await v(2, "user", randomUUID(), null, null, null)).toBe("23514");
      expect(await v(2, "agent", null, null, null, null)).toBe("23514");
      expect(await v(2, "user", null, null, ["e1"], null)).toBe("23514");
      expect(await v(2, "user", null, threadId, [], null)).toBe("23514");
      expect(await v(2, "user", null, null, null, `"text"`)).toBe("23514");
      expect(await v(2, "import", null, null, null, null)).toBeUndefined();
      expect(
        await code(
          c,
          `INSERT INTO site_memory_item_versions (item_id, version, statement, actor_kind, actor_user_id)
           SELECT id, 9, 'From a pass', 'pass', $1 FROM site_memory_items LIMIT 1`,
          [userId],
        ),
      ).toBe("23514");
    });
  });

  it("keeps versions immutable; deleting the item takes its versions and run records", async () => {
    await asAppInTeam(teamA, async (c) => {
      const [item] = (
        await c.query<{ id: string }>(
          `INSERT INTO semantic_memory_items (team_id, scope, owner_user_id, kind)
           VALUES ($1, 'user', $2, 'preference') RETURNING id`,
          [teamA, userId],
        )
      ).rows;
      await c.query(
        `INSERT INTO semantic_memory_item_versions (team_id, item_id, version, statement, actor_kind, actor_user_id)
         VALUES ($1, $2, 1, 'Prefers short answers', 'user', $3)`,
        [teamA, item?.id, userId],
      );
      await c.query(
        `INSERT INTO run_memory_items (team_id, run_id, item_id, version) VALUES ($1, $2, $3, 1)`,
        [teamA, runId, item?.id],
      );
      // The trigger refuses any role; the app role has no UPDATE or DELETE on site-wide versions.
      for (const table of VERSION_TABLES) {
        const refused = table === "semantic_memory_item_versions" ? "55000" : "42501";
        expect(await code(c, `UPDATE ${table} SET lint_override = true`), table).toBe(refused);
        expect(await code(c, `DELETE FROM ${table}`), table).toBe(refused);
      }
      await asAdmin(async (admin) => {
        await admin.query("BEGIN");
        for (const table of VERSION_TABLES) {
          expect(await code(admin, `UPDATE ${table} SET lint_override = true`), table).toBe(
            "55000",
          );
          expect(await code(admin, `DELETE FROM ${table}`), table).toBe("55000");
        }
        await admin.query("ROLLBACK");
      });
      await c.query(`DELETE FROM semantic_memory_items WHERE team_id = $1 AND id = $2`, [
        teamA,
        item?.id,
      ]);
      const left = await c.query(
        `SELECT 1 FROM semantic_memory_item_versions WHERE item_id = $1
         UNION ALL SELECT 1 FROM run_memory_items WHERE item_id = $1`,
        [item?.id],
      );
      expect(left.rows).toEqual([]);
    });
  });

  it("refuses run records and replacements that point into another Workspace (ac-1)", async () => {
    const [b] = await asAppInTeam(teamB, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO semantic_memory_items (team_id, scope, kind) VALUES ($1, 'team', 'fact') RETURNING id`,
        [teamB],
      );
      await c.query(
        `INSERT INTO semantic_memory_item_versions (team_id, item_id, version, statement, actor_kind, actor_user_id)
         VALUES ($1, $2, 1, 'B fact', 'user', $3)`,
        [teamB, rows[0]?.id, userId],
      );
      return rows;
    });
    await asAppInTeam(teamA, async (c) => {
      // Team B's item is invisible here, and the composite keys refuse it under team A's id.
      const seen = await c.query(`SELECT 1 FROM semantic_memory_items WHERE id = $1`, [b?.id]);
      expect(seen.rows).toEqual([]);
      expect(
        await code(
          c,
          `INSERT INTO run_memory_items (team_id, run_id, item_id, version) VALUES ($1, $2, $3, 1)`,
          [teamA, runId, b?.id],
        ),
      ).toBe("23503");
      expect(
        await code(
          c,
          `INSERT INTO semantic_memory_items (team_id, scope, kind, status, superseded_by)
           VALUES ($1, 'team', 'fact', 'superseded', $2)`,
          [teamA, b?.id],
        ),
      ).toBe("23503");
      expect(
        await code(
          c,
          `INSERT INTO semantic_memory_items (team_id, scope, kind) VALUES ($1, 'team', 'fact')`,
          [teamB],
        ),
      ).toBe("42501");
    });
  });

  it("supersedes a portable item only with the same person's item", async () => {
    const other = randomUUID();
    await asAdmin((c) =>
      c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'Bo', $2)`, [
        other,
        `${other}@example.test`,
      ]),
    );
    await asAppInTeam(teamA, async (c) => {
      const mine = await c.query<{ id: string }>(
        `INSERT INTO portable_memory_items (owner_user_id, kind) VALUES ($1, 'preference') RETURNING id`,
        [userId],
      );
      const insert = `INSERT INTO portable_memory_items (owner_user_id, kind, status, superseded_by)
                      VALUES ($1, 'preference', 'superseded', $2)`;
      expect(await code(c, insert, [other, mine.rows[0]?.id])).toBe("23503");
      expect(await code(c, insert, [userId, mine.rows[0]?.id])).toBeUndefined();
    });
  });
});
