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
 * KOBE-647 (v1.3 Semantic Memory SMA11a, SM28), migrations 0224-0225: the Site-wide legal hold.
 * `site_legal_holds` is a site-wide table (no team_id) with the lifecycle and two-person rule of
 * `legal_holds`; while one is active, deleting Site items or versions (purge, version-cap pruning,
 * cascades) and truncating the Site tables fail with KH001. Items written before the upgrade are
 * held like new ones; Workspace memory is unaffected by a Site hold.
 */
const MARKER = 'CREATE TABLE "site_legal_holds"';

let db: TestDatabase | undefined;
let older = "";
const teamA = randomUUID();
const ann = randomUUID(); // site admin, requester
const ben = randomUUID(); // site admin, approver
const cat = randomUUID(); // member, not an admin
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
const asOwner = <T>(fn: (c: pg.Client) => Promise<T>) => withClient(database().ownerUrl, fn);

/** Runs `fn` as the app role inside a team transaction; rolls back unless `commit`. */
async function asApp<T>(fn: (c: pg.Client) => Promise<T>, commit = false) {
  return withClient(database().appUrl, async (c) => {
    await c.query("BEGIN");
    try {
      await c.query(`SELECT set_config('kobe.team_id', $1, true)`, [teamA]);
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

const first = async (c: pg.Client, sql: string, params: unknown[] = []) => {
  const { rows } = await c.query<{ id: string }>(sql, params);
  if (!rows[0]) throw new Error(`no row: ${sql}`);
  return rows[0].id;
};

/** A Site item with versions 1..3 (current 3). */
async function siteItem(c: pg.Client): Promise<string> {
  const id = await first(
    c,
    `INSERT INTO site_memory_items (kind, current_version) VALUES ('fact', 3) RETURNING id`,
  );
  await c.query(
    `INSERT INTO site_memory_item_versions (item_id, version, statement, actor_kind, actor_user_id)
     SELECT $1, v, 'Site v' || v, 'user', $2 FROM generate_series(1, 3) v`,
    [id, ann],
  );
  return id;
}

/** A Workspace item of teamA with versions 1..3 (current 3). */
async function wsItem(c: pg.Client): Promise<string> {
  const id = await first(
    c,
    `INSERT INTO semantic_memory_items (team_id, scope, owner_user_id, kind, current_version)
     VALUES ($1, 'user', $2, 'fact', 3) RETURNING id`,
    [teamA, cat],
  );
  await c.query(
    `INSERT INTO semantic_memory_item_versions (team_id, item_id, version, statement, actor_kind, actor_user_id)
     SELECT $1, $2, v, 'Fact v' || v, 'user', $3 FROM generate_series(1, 3) v`,
    [teamA, id, cat],
  );
  return id;
}

/** A running run of teamA (on its own thread); `c` is the app role in teamA. */
async function runIn(c: pg.Client): Promise<string> {
  const thread = await first(
    c,
    `INSERT INTO threads (team_id, owner_user_id, title) VALUES ($1, $2, 'T') RETURNING id`,
    [teamA, cat],
  );
  return first(
    c,
    `INSERT INTO runs (team_id, thread_id, trigger, status, started_at)
     VALUES ($1, $2, 'user', 'running', now()) RETURNING id`,
    [teamA, thread],
  );
}

/** Places and approves a Site hold (ann asks, ben approves); returns its id. */
async function activeHold(): Promise<string> {
  return asApp(async (c) => {
    const id = await first(
      c,
      `INSERT INTO site_legal_holds (reason, placed_by) VALUES ('matter 7', $1) RETURNING id`,
      [ann],
    );
    await c.query(`UPDATE site_legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`, [
      id,
      ben,
    ]);
    return id;
  }, true);
}

/** Releases an active Site hold (ben asks, ann approves). */
async function release(id: string): Promise<void> {
  await asApp(async (c) => {
    await c.query(
      `UPDATE site_legal_holds SET release_requested_by = $2, release_reason = 'closed' WHERE id = $1`,
      [id, ben],
    );
    await c.query(
      `UPDATE site_legal_holds SET status = 'released', released_by = $2 WHERE id = $1`,
      [id, ann],
    );
  }, true);
}

beforeAll(async () => {
  older = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: older });
  await asAdmin(async (c) => {
    await c.query(
      `INSERT INTO users (id, name, email) VALUES ($1, 'Ann', $2), ($3, 'Ben', $4), ($5, 'Cat', $6)`,
      [ann, `${ann}@example.test`, ben, `${ben}@example.test`, cat, `${cat}@example.test`],
    );
    await c.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin'), ($2, 'admin')`, [
      ann,
      ben,
    ]);
    await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'A')`, [
      teamA,
      `a-${teamA.slice(0, 8)}`,
    ]);
  });
  oldItem = await asApp((c) => siteItem(c), true);
  await runMigrations({ databaseUrl: database().ownerUrl, appRole: database().appRole });
}, 180_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("Site-wide legal hold lifecycle (0224-0225, KOBE-647)", () => {
  it("starts as a pending request by a site admin, stamped by the database", async () => {
    await asApp(async (c) => {
      expect(
        await code(
          c,
          `INSERT INTO site_legal_holds (reason, placed_by, status) VALUES ('m', $1, 'active')`,
          [ann],
        ),
      ).toBe("55000");
      expect(
        await code(c, `INSERT INTO site_legal_holds (reason, placed_by) VALUES ('m', $1)`, [cat]),
      ).toBe("42501");
      expect(
        await code(c, `INSERT INTO site_legal_holds (reason, placed_by) VALUES ('  ', $1)`, [ann]),
      ).toBe("23514");
      const id = await first(
        c,
        `INSERT INTO site_legal_holds (reason, placed_by, requested_at)
         VALUES ('m', $1, now() - interval '9 days') RETURNING id`,
        [ann],
      );
      const { rows } = await c.query<{ status: string; fresh: boolean }>(
        `SELECT status, requested_at > now() - interval '1 minute' AS fresh FROM site_legal_holds WHERE id = $1`,
        [id],
      );
      expect(rows).toEqual([{ status: "pending", fresh: true }]);
    });
  });

  it("needs a second site admin to approve while one exists, and never changes the request", async () => {
    await asApp(async (c) => {
      const id = await first(
        c,
        `INSERT INTO site_legal_holds (reason, placed_by) VALUES ('m', $1) RETURNING id`,
        [ann],
      );
      const approve = `UPDATE site_legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`;
      expect(await code(c, approve, [id, ann])).toBe("42501");
      expect(await code(c, approve, [id, cat])).toBe("42501");
      expect(await code(c, `UPDATE site_legal_holds SET reason = 'x' WHERE id = $1`, [id])).toBe(
        "55000",
      );
      expect(await code(c, approve, [id, ben])).toBeUndefined();
      const { rows } = await c.query(
        `SELECT status, self_approved, approved_at IS NOT NULL AS stamped FROM site_legal_holds WHERE id = $1`,
        [id],
      );
      expect(rows).toEqual([{ status: "active", self_approved: false, stamped: true }]);
      // Released only through an approved release request, by a second admin.
      expect(
        await code(
          c,
          `UPDATE site_legal_holds SET status = 'released', released_by = $2 WHERE id = $1`,
          [id, ben],
        ),
      ).toBe("55000");
      await c.query(
        `UPDATE site_legal_holds SET release_requested_by = $2, release_reason = 'done' WHERE id = $1`,
        [id, ann],
      );
      const free = `UPDATE site_legal_holds SET status = 'released', released_by = $2 WHERE id = $1`;
      expect(await code(c, free, [id, ann])).toBe("42501");
      expect(await code(c, free, [id, ben])).toBeUndefined();
    });
  });

  it("self-approves (flagged) on a single-admin site", async () => {
    await asAdmin((c) => c.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [ben]));
    try {
      await asApp(async (c) => {
        const id = await first(
          c,
          `INSERT INTO site_legal_holds (reason, placed_by) VALUES ('m', $1) RETURNING id`,
          [ann],
        );
        await c.query(
          `UPDATE site_legal_holds SET status = 'active', approved_by = $1 WHERE id = $2`,
          [ann, id],
        );
        const { rows } = await c.query(`SELECT self_approved FROM site_legal_holds WHERE id = $1`, [
          id,
        ]);
        expect(rows).toEqual([{ self_approved: true }]);
      });
    } finally {
      await asAdmin((c) => c.query(`UPDATE users SET deactivated_at = NULL WHERE id = $1`, [ben]));
    }
  });

  it("lets the requester withdraw and another admin deny a pending request", async () => {
    await asApp(async (c) => {
      const ask = `INSERT INTO site_legal_holds (reason, placed_by) VALUES ('m', $1) RETURNING id`;
      const a = await first(c, ask, [ann]);
      const close = `UPDATE site_legal_holds SET status = $2, closed_by = $3 WHERE id = $1`;
      expect(await code(c, close, [a, "withdrawn", ben])).toBe("42501");
      expect(await code(c, close, [a, "denied", ann])).toBe("42501");
      expect(await code(c, close, [a, "withdrawn", ann])).toBeUndefined();
      const b = await first(c, ask, [ann]);
      expect(await code(c, close, [b, "denied", ben])).toBeUndefined();
      expect(
        await code(
          c,
          `UPDATE site_legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`,
          [b, ben],
        ),
      ).toBe("55000");
    });
  });

  it("is never deleted by the app role", async () => {
    await asApp(async (c) => {
      expect(await code(c, `DELETE FROM site_legal_holds`)).toBe("42501");
    });
  });
});

describe("Site-wide legal hold guards on Site memory (0225, KOBE-647)", () => {
  it("refuses purging, pruning or truncating Site memory while active, including pre-upgrade items", async () => {
    const fresh = await asApp((c) => siteItem(c), true);
    const ws = await asApp((c) => wsItem(c), true);
    const hold = await activeHold();
    await asApp(async (c) => {
      for (const item of [oldItem, fresh]) {
        expect(
          await code(
            c,
            `DELETE FROM site_memory_item_versions WHERE item_id = $1 AND version = 1`,
            [item],
          ),
        ).toBe(LEGAL_HOLD_SQLSTATE);
        expect(await code(c, `DELETE FROM site_memory_items WHERE id = $1`, [item])).toBe(
          LEGAL_HOLD_SQLSTATE,
        );
      }
      // Archiving removes nothing and stays allowed.
      expect(
        await code(c, `UPDATE site_memory_items SET status = 'archived' WHERE id = $1`, [fresh]),
      ).toBeUndefined();
      // A Site hold does not hold Workspace memory.
      expect(
        await code(c, `DELETE FROM semantic_memory_items WHERE team_id = $1 AND id = $2`, [
          teamA,
          ws,
        ]),
      ).toBeUndefined();
    });
    await asOwner(async (c) => {
      await c.query("BEGIN");
      try {
        expect(await code(c, `TRUNCATE site_memory_item_versions CASCADE`)).toBe(
          LEGAL_HOLD_SQLSTATE,
        );
        expect(await code(c, `TRUNCATE site_memory_items CASCADE`)).toBe(LEGAL_HOLD_SQLSTATE);
      } finally {
        await c.query("ROLLBACK");
      }
    });

    await release(hold);
    await asApp(async (c) => {
      expect(
        await code(c, `DELETE FROM site_memory_item_versions WHERE item_id = $1 AND version = 1`, [
          fresh,
        ]),
      ).toBeUndefined();
      expect(await code(c, `DELETE FROM site_memory_items WHERE id = $1`, [fresh])).toBeUndefined();
    });
  });

  it("keeps a Site item a run used, and its run record, under a hold; run purges still pass", async () => {
    const [item, run] = await asApp(async (c) => {
      const id = await siteItem(c);
      const r = await runIn(c);
      await c.query(
        `INSERT INTO run_site_memory_items (team_id, run_id, item_id, version) VALUES ($1, $2, $3, 1)`,
        [teamA, r, id],
      );
      return [id, r] as const;
    }, true);
    const records = (c: pg.Client) =>
      c
        .query(`SELECT 1 FROM run_site_memory_items WHERE team_id = $1 AND item_id = $2`, [
          teamA,
          item,
        ])
        .then((r) => r.rowCount);
    const hold = await activeHold();
    try {
      await asApp(async (c) => {
        expect(await code(c, `DELETE FROM site_memory_items WHERE id = $1`, [item])).toBe(
          LEGAL_HOLD_SQLSTATE,
        );
        expect(await records(c)).toBe(1);
        // The run record is Workspace data (no Workspace hold here): purging the run takes it.
        expect(
          await code(c, `DELETE FROM runs WHERE team_id = $1 AND id = $2`, [teamA, run]),
        ).toBeUndefined();
        expect(await records(c)).toBe(0);
      }, true);
    } finally {
      await release(hold);
    }
    // No hold: the item delete cascades to its versions and any run record.
    const [item2] = await asApp(async (c) => {
      const id = await siteItem(c);
      const r = await runIn(c);
      await c.query(
        `INSERT INTO run_site_memory_items (team_id, run_id, item_id, version) VALUES ($1, $2, $3, 2)`,
        [teamA, r, id],
      );
      return [id] as const;
    }, true);
    await asApp(async (c) => {
      expect(await code(c, `DELETE FROM site_memory_items WHERE id = $1`, [item2])).toBeUndefined();
      const left = await c.query(
        `SELECT (SELECT count(*) FROM site_memory_item_versions WHERE item_id = $1)::int AS versions,
                (SELECT count(*) FROM run_site_memory_items WHERE team_id = $2 AND item_id = $1)::int AS records`,
        [item2, teamA],
      );
      expect(left.rows).toEqual([{ versions: 0, records: 0 }]);
    });
  });

  it("orders an approval after purges in flight (shared hold lock)", async () => {
    const item = await asApp((c) => siteItem(c), true);
    const ask = await asApp(
      (c) =>
        first(c, `INSERT INTO site_legal_holds (reason, placed_by) VALUES ('m', $1) RETURNING id`, [
          ann,
        ]),
      true,
    );
    await withClient(database().appUrl, async (purge) => {
      await purge.query("BEGIN");
      await purge.query(`SELECT public.legal_hold_lock_shared()`);
      await withClient(database().appUrl, async (approver) => {
        await approver.query(`SET lock_timeout = '300ms'`);
        await expect(
          approver.query(
            `UPDATE site_legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`,
            [ask, ben],
          ),
        ).rejects.toMatchObject({ code: "55P03" });
      });
      await purge.query(`DELETE FROM site_memory_items WHERE id = $1`, [item]);
      await purge.query("COMMIT");
    });
  });

  it("stays invoker-rights with a pinned search_path", async () => {
    await asAdmin(async (c) => {
      const { rows } = await c.query<{ name: string; definer: boolean; config: string[] }>(
        `SELECT proname AS name, prosecdef AS definer, proconfig AS config FROM pg_proc
          WHERE proname LIKE 'site_legal_hold%' OR proname LIKE 'site_memory_%legal_hold%'
          ORDER BY proname`,
      );
      expect(rows.map((r) => r.name)).toEqual([
        "site_legal_hold_active",
        "site_legal_hold_refuse_truncate",
        "site_legal_holds_guard",
        "site_memory_legal_hold_guard",
      ]);
      for (const r of rows) {
        expect(r, r.name).toMatchObject({
          definer: false,
          config: ["search_path=pg_catalog, public"],
        });
      }
    });
  });
});
