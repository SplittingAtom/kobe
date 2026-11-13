import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LEGAL_HOLD_SQLSTATE } from "./legal-hold/index.js";
import { runMigrations } from "./migrate.js";
import {
  createTestDatabase,
  migrationsBefore,
  testServerUrl,
  type TestDatabase,
} from "./test-support/database.js";

/**
 * KOBE-378 (v1.3 Semantic Memory SMA3), migration 0222: the version cap may delete a version only
 * when it is not its item's current version and no run record (any lane, any Workspace) uses it.
 * Item and team cascades keep working; the KH001 hold guard still applies. Items written before the
 * upgrade are pruned like new ones.
 */
const MARKER = "run_memory_items_prune_guard";

let db: TestDatabase | undefined;
let older = "";
const teamA = randomUUID();
const teamB = randomUUID();
const ann = randomUUID();
const approver = randomUUID();
const requester = randomUUID();
let oldItem = "";

const database = (): TestDatabase => {
  if (!db) throw new Error("database not created");
  return db;
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
const asAdmin = <T>(fn: (c: pg.Client) => Promise<T>) => withClient(database().adminUrl, fn);

/** Runs `fn` as the app role inside a team transaction; rolls back unless `commit`. */
async function inTeam<T>(team: string, fn: (c: pg.Client) => Promise<T>, commit = false) {
  return withClient(database().appUrl, async (c) => {
    await c.query("BEGIN");
    try {
      await c.query(`SELECT set_config('kobe.team_id', $1, true)`, [team]);
      const out = await fn(c);
      await c.query(commit ? "COMMIT" : "ROLLBACK");
      return out;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    }
  });
}

/** The SQLSTATE `sql` fails with, in a savepoint (undefined: it passed). */
async function code(c: pg.Client, sql: string, params: unknown[] = []) {
  await c.query("SAVEPOINT p");
  try {
    await c.query(sql, params);
    await c.query("RELEASE SAVEPOINT p");
    return undefined;
  } catch (e) {
    await c.query("ROLLBACK TO SAVEPOINT p");
    return (e as { code?: string }).code;
  }
}

const first = async (c: pg.Client, sql: string, params: unknown[]) => {
  const { rows } = await c.query<{ id: string }>(sql, params);
  if (!rows[0]) throw new Error(`no row: ${sql}`);
  return rows[0].id;
};

/** A Workspace item with versions 1..3 (current 3). */
async function wsItem(c: pg.Client, team: string): Promise<string> {
  const id = await first(
    c,
    `INSERT INTO semantic_memory_items (team_id, scope, owner_user_id, kind, current_version)
     VALUES ($1, 'user', $2, 'fact', 3) RETURNING id`,
    [team, ann],
  );
  await c.query(
    `INSERT INTO semantic_memory_item_versions (team_id, item_id, version, statement, actor_kind, actor_user_id)
     SELECT $1, $2, v, 'Fact v' || v, 'user', $3 FROM generate_series(1, 3) v`,
    [team, id, ann],
  );
  return id;
}

async function portableItem(c: pg.Client): Promise<string> {
  const id = await first(
    c,
    `INSERT INTO portable_memory_items (owner_user_id, kind, current_version)
     VALUES ($1, 'preference', 3) RETURNING id`,
    [ann],
  );
  await c.query(
    `INSERT INTO portable_memory_item_versions (item_id, version, statement, actor_kind, actor_user_id)
     SELECT $1, v, 'Pref v' || v, 'user', $2 FROM generate_series(1, 3) v`,
    [id, ann],
  );
  return id;
}

async function siteItem(c: pg.Client): Promise<string> {
  const id = await first(
    c,
    `INSERT INTO site_memory_items (kind, current_version) VALUES ('fact', 3) RETURNING id`,
    [],
  );
  await c.query(
    `INSERT INTO site_memory_item_versions (item_id, version, statement, actor_kind, actor_user_id)
     SELECT $1, v, 'Site v' || v, 'user', $2 FROM generate_series(1, 3) v`,
    [id, ann],
  );
  return id;
}

async function runIn(team: string): Promise<string> {
  return asAdmin(async (c) => {
    const thread = await first(
      c,
      `INSERT INTO threads (team_id, owner_user_id, title) VALUES ($1, $2, 'T') RETURNING id`,
      [team, ann],
    );
    return first(
      c,
      `INSERT INTO runs (team_id, thread_id, trigger, status, started_at)
       VALUES ($1, $2, 'user', 'running', now()) RETURNING id`,
      [team, thread],
    );
  });
}

const versions = async (c: pg.Client, table: string, item: string) =>
  (
    await c.query<{ version: number }>(
      `SELECT version FROM ${table} WHERE item_id = $1 ORDER BY version`,
      [item],
    )
  ).rows.map((r) => r.version);

beforeAll(async () => {
  older = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: older });
  await asAdmin(async (c) => {
    await c.query(
      `INSERT INTO users (id, name, email) VALUES ($1, 'Ann', $2), ($3, 'Ap', $4), ($5, 'Rq', $6)`,
      [
        ann,
        `${ann}@example.test`,
        approver,
        `${approver}@example.test`,
        requester,
        `${requester}@example.test`,
      ],
    );
    await c.query(
      `INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin'), ($2, 'admin'), ($3, 'admin')`,
      [ann, approver, requester],
    );
    await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'A'), ($3, $4, 'B')`, [
      teamA,
      `a-${teamA.slice(0, 8)}`,
      teamB,
      `b-${teamB.slice(0, 8)}`,
    ]);
  });
  oldItem = await inTeam(teamA, (c) => wsItem(c, teamA), true);
  await runMigrations({ databaseUrl: database().ownerUrl, appRole: database().appRole });
}, 180_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("version pruning (0222, KOBE-378)", () => {
  it("prunes a non-current version of an item written before the upgrade, never the current one", async () => {
    await inTeam(teamA, async (c) => {
      const del = `DELETE FROM semantic_memory_item_versions WHERE team_id = $1 AND item_id = $2 AND version = $3`;
      expect(await code(c, del, [teamA, oldItem, 1])).toBeUndefined();
      expect(await code(c, del, [teamA, oldItem, 3])).toBe("55000");
      expect(await versions(c, "semantic_memory_item_versions", oldItem)).toEqual([2, 3]);
    });
  });

  it("prunes portable and Site versions as the app role (grant) but not their current version", async () => {
    await inTeam(teamA, async (c) => {
      for (const [table, make] of [
        ["portable_memory_item_versions", portableItem],
        ["site_memory_item_versions", siteItem],
      ] as const) {
        const item = await make(c);
        const del = `DELETE FROM ${table} WHERE item_id = $1 AND version = $2`;
        expect(await code(c, del, [item, 1]), table).toBeUndefined();
        expect(await code(c, del, [item, 3]), table).toBe("55000");
        expect(await versions(c, table, item), table).toEqual([2, 3]);
      }
    });
  });

  it("refuses pruning a Workspace version a run used", async () => {
    const run = await runIn(teamA);
    await inTeam(teamA, async (c) => {
      const item = await wsItem(c, teamA);
      await c.query(
        `INSERT INTO run_memory_items (team_id, run_id, item_id, version) VALUES ($1, $2, $3, 1)`,
        [teamA, run, item],
      );
      const del = `DELETE FROM semantic_memory_item_versions WHERE team_id = $1 AND item_id = $2 AND version = $3`;
      expect(await code(c, del, [teamA, item, 1])).toBe("55000");
      expect(await code(c, del, [teamA, item, 2])).toBeUndefined();
    });
  });

  it("refuses pruning a portable or Site version a run in another Workspace used (invisible under RLS)", async () => {
    const runB = await runIn(teamB);
    const [pt, st] = await inTeam(
      teamA,
      async (c) => [await portableItem(c), await siteItem(c)],
      true,
    );
    await inTeam(
      teamB,
      async (c) => {
        await c.query(
          `INSERT INTO run_portable_memory_items (team_id, run_id, item_id, version) VALUES ($1, $2, $3, 1)`,
          [teamB, runB, pt],
        );
        await c.query(
          `INSERT INTO run_site_memory_items (team_id, run_id, item_id, version) VALUES ($1, $2, $3, 1)`,
          [teamB, runB, st],
        );
      },
      true,
    );
    await inTeam(teamA, async (c) => {
      expect(
        await code(
          c,
          `DELETE FROM portable_memory_item_versions WHERE item_id = $1 AND version = 1`,
          [pt],
        ),
      ).toBe("55000");
      expect(
        await code(c, `DELETE FROM site_memory_item_versions WHERE item_id = $1 AND version = 1`, [
          st,
        ]),
      ).toBe("55000");
      // Unused versions of the same items still prune.
      expect(
        await code(
          c,
          `DELETE FROM portable_memory_item_versions WHERE item_id = $1 AND version = 2`,
          [pt],
        ),
      ).toBeUndefined();
      expect(
        await code(c, `DELETE FROM site_memory_item_versions WHERE item_id = $1 AND version = 2`, [
          st,
        ]),
      ).toBeUndefined();
    });
    // In the run's own Workspace the version trigger refuses it directly.
    await inTeam(teamB, async (c) => {
      expect(
        await code(
          c,
          `DELETE FROM portable_memory_item_versions WHERE item_id = $1 AND version = 1`,
          [pt],
        ),
      ).toBe("55000");
    });
    // Deleting the whole item still takes its run records in every Workspace (M2).
    await inTeam(teamA, async (c) => {
      expect(
        await code(c, `DELETE FROM portable_memory_items WHERE id = $1`, [pt]),
      ).toBeUndefined();
      expect(await code(c, `DELETE FROM site_memory_items WHERE id = $1`, [st])).toBeUndefined();
    });
  });

  it("refuses pruning a held Workspace version (KH001)", async () => {
    const item = await inTeam(teamA, (c) => wsItem(c, teamA), true);
    const hold = await asAdmin((c) =>
      first(
        c,
        `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'matter', $3) RETURNING id`,
        [teamA, ann, requester],
      ),
    );
    await asAdmin((c) =>
      c.query(`UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`, [
        hold,
        approver,
      ]),
    );
    await inTeam(teamA, async (c) => {
      const del = `DELETE FROM semantic_memory_item_versions WHERE team_id = $1 AND item_id = $2 AND version = 1`;
      expect(await code(c, del, [teamA, item])).toBe(LEGAL_HOLD_SQLSTATE);
    });
  });

  it("keeps item and team cascades and still refuses UPDATE", async () => {
    const run = await runIn(teamB);
    const item = await inTeam(
      teamB,
      async (c) => {
        const id = await wsItem(c, teamB);
        await c.query(
          `INSERT INTO run_memory_items (team_id, run_id, item_id, version) VALUES ($1, $2, $3, 1)`,
          [teamB, run, id],
        );
        return id;
      },
      true,
    );
    await inTeam(teamB, async (c) => {
      expect(
        await code(
          c,
          `UPDATE semantic_memory_item_versions SET lint_override = true WHERE item_id = $1`,
          [item],
        ),
      ).toBe("55000");
      expect(
        await code(c, `DELETE FROM semantic_memory_items WHERE team_id = $1 AND id = $2`, [
          teamB,
          item,
        ]),
      ).toBeUndefined();
      expect(await versions(c, "semantic_memory_item_versions", item)).toEqual([]);
    });
    await inTeam(teamB, (c) => wsItem(c, teamB), true);
    await asAdmin(async (c) => {
      const team = await first(c, `INSERT INTO teams (slug, name) VALUES ($1, 'C') RETURNING id`, [
        `c-${randomUUID().slice(0, 8)}`,
      ]);
      const runC = await runIn(team);
      await inTeam(
        team,
        async (t) => {
          const id = await wsItem(t, team);
          await t.query(
            `INSERT INTO run_memory_items (team_id, run_id, item_id, version) VALUES ($1, $2, $3, 1)`,
            [team, runC, id],
          );
        },
        true,
      );
      await c.query(`DELETE FROM teams WHERE id = $1`, [team]);
      const left = await c.query(`SELECT 1 FROM semantic_memory_items WHERE team_id = $1`, [team]);
      expect(left.rows).toEqual([]);
    });
  });

  it("stays invoker-rights with a pinned search_path", async () => {
    await asAdmin(async (c) => {
      const { rows } = await c.query<{ name: string; definer: boolean; config: string[] }>(
        `SELECT proname AS name, prosecdef AS definer, proconfig AS config FROM pg_proc
          WHERE proname IN ('semantic_memory_versions_immutable', 'run_memory_items_prune_guard')
          ORDER BY proname`,
      );
      expect(rows).toEqual([
        {
          name: "run_memory_items_prune_guard",
          definer: false,
          config: ["search_path=pg_catalog, public"],
        },
        {
          name: "semantic_memory_versions_immutable",
          definer: false,
          config: ["search_path=pg_catalog, public"],
        },
      ]);
    });
  });
});
