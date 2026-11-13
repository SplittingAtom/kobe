import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { LEGAL_HOLD_SQLSTATE } from "./legal-hold/index.js";

/**
 * KOBE-376 (v1.3 Semantic Memory SMA1): constraints, keys, legal-hold guards and immutability of
 * the semantic memory tables (structure on upgrade: semantic-memory-upgrade.db.test.ts; isolation:
 * probe.db.test.ts). Raw SQL as the app role inside a team transaction, as withTeam() does.
 */
const admin = new pg.Client({ connectionString: inject("adminUrl") });
const teamA = randomUUID();
const teamB = randomUUID();
const owner = randomUUID();
const other = randomUUID();
const requester = randomUUID();
const approver = randomUUID();
let threadA = "";
let runA = "";
let runB = "";

const VERSION_TABLES = [
  "semantic_memory_item_versions",
  "portable_memory_item_versions",
  "site_memory_item_versions",
];
const TEAM_TABLES = [
  "semantic_memory_items",
  "semantic_memory_item_versions",
  "run_memory_items",
  "run_portable_memory_items",
  "run_site_memory_items",
];

/** Runs `fn` as the app role in a team transaction; rolls back unless `commit`. */
async function inTeam<T>(
  teamId: string,
  fn: (c: pg.Client) => Promise<T>,
  commit = false,
): Promise<T> {
  const c = new pg.Client({ connectionString: inject("appUrl") });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SELECT set_config('kobe.team_id', $1, true)`, [teamId]);
    const result = await fn(c);
    await c.query(commit ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    await c.end();
  }
}

/** The SQLSTATE `sql` fails with (deferred keys checked too), in a savepoint. */
async function code(
  c: pg.Client,
  sql: string,
  params: unknown[] = [],
): Promise<string | undefined> {
  await c.query("SAVEPOINT probe");
  try {
    await c.query(sql, params);
    await c.query("SET CONSTRAINTS ALL IMMEDIATE");
    await c.query("SET CONSTRAINTS ALL DEFERRED");
    await c.query("RELEASE SAVEPOINT probe");
    return undefined;
  } catch (err) {
    await c.query("ROLLBACK TO SAVEPOINT probe");
    return (err as { code?: string }).code;
  }
}

const one = async (c: pg.Client, sql: string, params: unknown[]): Promise<string> => {
  const { rows } = await c.query<{ id: string }>(sql, params);
  const id = rows[0]?.id;
  if (!id) throw new Error(`no row: ${sql}`);
  return id;
};

/** A Workspace item with version 1 (one statement: the version key is deferred anyway). */
const wsItem = (c: pg.Client, team: string, scope: "user" | "team", ownerId: string | null) =>
  one(
    c,
    `WITH i AS (INSERT INTO semantic_memory_items (team_id, scope, owner_user_id, kind)
                VALUES ($1, $2, $3, 'fact') RETURNING team_id, id)
     INSERT INTO semantic_memory_item_versions (team_id, item_id, version, statement, actor_kind, actor_user_id)
     SELECT team_id, id, 1, 'A fact', 'user', $4 FROM i RETURNING item_id AS id`,
    [team, scope, ownerId, ownerId ?? owner],
  );

const portableItem = (c: pg.Client, ownerId: string) =>
  one(
    c,
    `WITH i AS (INSERT INTO portable_memory_items (owner_user_id, kind) VALUES ($1, 'preference') RETURNING id)
     INSERT INTO portable_memory_item_versions (item_id, version, statement, actor_kind, actor_user_id)
     SELECT id, 1, 'Prefers metric units', 'user', $1 FROM i RETURNING item_id AS id`,
    [ownerId],
  );

const siteItem = (c: pg.Client) =>
  one(
    c,
    `WITH i AS (INSERT INTO site_memory_items (kind, policy) VALUES ('convention', true) RETURNING id)
     INSERT INTO site_memory_item_versions (item_id, version, statement, actor_kind, actor_user_id)
     SELECT id, 1, 'Never share customer names', 'user', $1 FROM i RETURNING item_id AS id`,
    [owner],
  );

const run = async (team: string): Promise<{ thread: string; run: string }> => {
  const thread = await one(
    admin,
    `INSERT INTO threads (team_id, owner_user_id, title) VALUES ($1, $2, 'T') RETURNING id`,
    [team, owner],
  );
  const id = await one(
    admin,
    `INSERT INTO runs (team_id, thread_id, trigger, status, started_at)
     VALUES ($1, $2, 'user', 'running', now()) RETURNING id`,
    [team, thread],
  );
  return { thread, run: id };
};

async function hold(team: string, userId: string | null): Promise<string> {
  const id = await one(
    admin,
    `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'matter', $3) RETURNING id`,
    [team, userId, requester],
  );
  await admin.query(`UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`, [
    id,
    approver,
  ]);
  return id;
}

async function release(id: string): Promise<void> {
  await admin.query(
    `UPDATE legal_holds SET release_requested_by = $2, release_requested_at = now(), release_reason = 'done' WHERE id = $1`,
    [id, requester],
  );
  await admin.query(`UPDATE legal_holds SET status = 'released', released_by = $2 WHERE id = $1`, [
    id,
    approver,
  ]);
}

beforeAll(async () => {
  await admin.connect();
  for (const [id, name] of [
    [owner, "Ann"],
    [other, "Bo"],
    [requester, "Req"],
    [approver, "App"],
  ] as const) {
    await admin.query(`INSERT INTO users (id, name, email) VALUES ($1, $2, $3)`, [
      id,
      name,
      `${id}@sm.test`,
    ]);
  }
  for (const id of [requester, approver]) {
    await admin.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin')`, [id]);
  }
  await admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'A'), ($3, $4, 'B')`, [
    teamA,
    `sm-${teamA.slice(0, 8)}`,
    teamB,
    `sm-${teamB.slice(0, 8)}`,
  ]);
  ({ thread: threadA, run: runA } = await run(teamA));
  ({ run: runB } = await run(teamB));
});

afterAll(() => admin.end());

describe("semantic memory checks (ac-3)", () => {
  it("refuses a portable item that is not a preference", async () => {
    await inTeam(teamA, async (c) => {
      await portableItem(c, owner);
      const insert = `INSERT INTO portable_memory_items (owner_user_id, kind) VALUES ($1, $2)`;
      for (const kind of ["fact", "convention", "definition", "decision", "policy"]) {
        expect(await code(c, insert, [owner, kind]), kind).toBe("23514");
      }
    });
  });

  it("keeps Policy in the Site table only", async () => {
    await inTeam(teamA, async (c) => {
      await siteItem(c);
      const ws = `INSERT INTO semantic_memory_items (team_id, scope, kind, policy) VALUES ($1, 'team', 'fact', true)`;
      expect(await code(c, ws, [teamA])).toBe("42703");
      const pt = `INSERT INTO portable_memory_items (owner_user_id, kind, policy) VALUES ($1, 'preference', true)`;
      expect(await code(c, pt, [owner])).toBe("42703");
      const kind = `INSERT INTO semantic_memory_items (team_id, scope, kind) VALUES ($1, 'team', 'policy')`;
      expect(await code(c, kind, [teamA])).toBe("23514");
      expect(await code(c, `INSERT INTO site_memory_items (kind) VALUES ('policy')`)).toBe("23514");
    });
  });

  it("refuses blank statements and statements over 500 characters in every version table", async () => {
    await inTeam(teamA, async (c) => {
      const ws = await wsItem(c, teamA, "team", null);
      const pt = await portableItem(c, owner);
      const st = await siteItem(c);
      const inserts: [string, unknown[]][] = [
        [
          `INSERT INTO semantic_memory_item_versions (team_id, item_id, version, statement, actor_kind, actor_user_id)
           VALUES ($1, $2, $3, $4, 'user', $5)`,
          [teamA, ws],
        ],
        [
          `INSERT INTO portable_memory_item_versions (item_id, version, statement, actor_kind, actor_user_id)
           VALUES ($1, $2, $3, 'user', $4)`,
          [pt],
        ],
        [
          `INSERT INTO site_memory_item_versions (item_id, version, statement, actor_kind, actor_user_id)
           VALUES ($1, $2, $3, 'user', $4)`,
          [st],
        ],
      ];
      for (const [sql, keys] of inserts) {
        expect(await code(c, sql, [...keys, 2, "x".repeat(501), owner]), sql).toBe("23514");
        expect(await code(c, sql, [...keys, 2, "   ", owner]), sql).toBe("23514");
        expect(await code(c, sql, [...keys, 2, "y".repeat(500), owner]), sql).toBeUndefined();
      }
      const stemmed = await c.query<{ tsv: string }>(
        `INSERT INTO site_memory_item_versions (item_id, version, statement, actor_kind, actor_user_id)
         VALUES ($1, 3, 'Running the weekly reports', 'user', $2) RETURNING statement_tsv::text AS tsv`,
        [st, owner],
      );
      expect(stemmed.rows).toEqual([{ tsv: "'report':4 'run':1 'week':3" }]);
    });
  });

  it("caps tags at five of 1..40 characters (L3)", async () => {
    await inTeam(teamA, async (c) => {
      const ws = await wsItem(c, teamA, "team", null);
      const pt = await portableItem(c, owner);
      const st = await siteItem(c);
      const updates: [string, unknown[]][] = [
        [`UPDATE semantic_memory_items SET tags = $1 WHERE team_id = $2 AND id = $3`, [teamA, ws]],
        [`UPDATE portable_memory_items SET tags = $1 WHERE id = $2`, [pt]],
        [`UPDATE site_memory_items SET tags = $1 WHERE id = $2`, [st]],
      ];
      const forty = "t".repeat(40);
      for (const [sql, keys] of updates) {
        expect(await code(c, sql, [[forty, forty, forty, forty, forty], ...keys])).toBeUndefined();
        expect(await code(c, sql, [["ok", "t".repeat(41)], ...keys]), sql).toBe("23514");
        expect(await code(c, sql, [["a", "b", "c", "d", "e", "f"], ...keys]), sql).toBe("23514");
        expect(await code(c, sql, [[""], ...keys]), sql).toBe("23514");
        expect(await code(c, sql, [["a\nb"], ...keys]), sql).toBe("23514");
        expect(await code(c, sql, [["ok", null], ...keys]), sql).toBe("23514");
      }
    });
  });

  it("holds scope, owner, supersession and provenance rules", async () => {
    await inTeam(teamA, async (c) => {
      const ws = `INSERT INTO semantic_memory_items (team_id, scope, owner_user_id, kind) VALUES ($1, $2, $3, 'fact')`;
      expect(await code(c, ws, [teamA, "user", null])).toBe("23514");
      expect(await code(c, ws, [teamA, "team", owner])).toBe("23514");
      expect(await code(c, ws, [teamA, "portable", owner])).toBe("23514");
      expect(await code(c, ws, [teamA, "site", null])).toBe("23514");
      const superseded = `INSERT INTO semantic_memory_items (team_id, scope, kind, status) VALUES ($1, 'team', 'fact', 'superseded')`;
      expect(await code(c, superseded, [teamA])).toBe("23514");
      const item = await wsItem(c, teamA, "team", null);
      const version = `INSERT INTO semantic_memory_item_versions
          (team_id, item_id, version, statement, actor_kind, actor_user_id, pass_id, source_thread_id, source_entry_ids, evidence)
          VALUES ($1, $2, $3, 'We ship on Tuesdays', $4, $5, $6, $7, $8, $9)`;
      const v = (n: number, kind: string, pass: string | null, ...rest: unknown[]) =>
        code(c, version, [teamA, item, n, kind, owner, pass, ...rest]);
      const quote = `[{"quote":"q"}]`;
      expect(await v(2, "pass", randomUUID(), threadA, ["e1"], quote)).toBeUndefined();
      expect(await v(3, "pass", null, null, null, null)).toBe("23514");
      expect(await v(3, "user", randomUUID(), null, null, null)).toBe("23514");
      expect(await v(3, "agent", null, null, null, null)).toBe("23514");
      expect(await v(3, "user", null, null, ["e1"], null)).toBe("23514");
      expect(await v(3, "user", null, threadA, [], null)).toBe("23514");
      expect(await v(3, "user", null, null, null, `"text"`)).toBe("23514");
      expect(await v(3, "import", null, null, null, null)).toBeUndefined();
    });
  });

  it("ties a portable version to its owner and keeps pass ids off it (L1, L5)", async () => {
    await inTeam(teamA, async (c) => {
      const pt = await portableItem(c, owner);
      const sql = `INSERT INTO portable_memory_item_versions (item_id, version, statement, actor_kind, actor_user_id)
                   VALUES ($1, $2, 'Prefers tea', $3, $4)`;
      expect(await code(c, sql, [pt, 2, "user", other])).toBe("23503");
      expect(await code(c, sql, [pt, 2, "pass", owner])).toBeUndefined();
      const passId = `INSERT INTO portable_memory_item_versions (item_id, version, statement, actor_kind, actor_user_id, pass_id)
                      VALUES ($1, 3, 'Prefers tea', 'pass', $2, $3)`;
      expect(await code(c, passId, [pt, owner, randomUUID()])).toBe("42703");
      const site = `INSERT INTO site_memory_item_versions (item_id, version, statement, actor_kind, actor_user_id)
                    VALUES ($1, 2, 'From a pass', 'pass', $2)`;
      expect(await code(c, site, [await siteItem(c), owner])).toBe("23514");
    });
  });

  it("requires current_version to name an existing version, checked at commit (L2)", async () => {
    await inTeam(teamA, async (c) => {
      const items: [string, unknown[]][] = [
        [
          `INSERT INTO semantic_memory_items (team_id, scope, kind) VALUES ($1, 'team', 'fact')`,
          [teamA],
        ],
        [
          `INSERT INTO portable_memory_items (owner_user_id, kind) VALUES ($1, 'preference')`,
          [owner],
        ],
        [`INSERT INTO site_memory_items (kind) VALUES ('fact')`, []],
      ];
      for (const [sql, params] of items) expect(await code(c, sql, params), sql).toBe("23503");
      const ws = await wsItem(c, teamA, "team", null);
      const bump = `UPDATE semantic_memory_items SET current_version = $3 WHERE team_id = $1 AND id = $2`;
      expect(await code(c, bump, [teamA, ws, 2])).toBe("23503");
      await c.query(
        `INSERT INTO semantic_memory_item_versions (team_id, item_id, version, statement, actor_kind, actor_user_id)
         VALUES ($1, $2, 2, 'A fact, edited', 'user', $3)`,
        [teamA, ws, owner],
      );
      expect(await code(c, bump, [teamA, ws, 2])).toBeUndefined();
    });
  });
});

describe("semantic memory keys across Workspaces (ac-1)", () => {
  it("refuses run records and replacements that point into another Workspace", async () => {
    const b = await inTeam(teamB, (c) => wsItem(c, teamB, "team", null), true);
    await inTeam(teamA, async (c) => {
      const seen = await c.query(`SELECT 1 FROM semantic_memory_items WHERE id = $1`, [b]);
      expect(seen.rows).toEqual([]);
      const record = `INSERT INTO run_memory_items (team_id, run_id, item_id, version) VALUES ($1, $2, $3, 1)`;
      expect(await code(c, record, [teamA, runA, b])).toBe("23503");
      expect(await code(c, record, [teamA, runB, await wsItem(c, teamA, "team", null)])).toBe(
        "23503",
      );
      const replaced = `INSERT INTO semantic_memory_items (team_id, scope, kind, status, superseded_by)
                        VALUES ($1, 'team', 'fact', 'superseded', $2)`;
      expect(await code(c, replaced, [teamA, b])).toBe("23503");
      const foreign = `INSERT INTO semantic_memory_items (team_id, scope, kind) VALUES ($1, 'team', 'fact')`;
      expect(await code(c, foreign, [teamB])).toBe("42501");
    });
  });

  it("supersedes a portable item only with the same person's item", async () => {
    await inTeam(teamA, async (c) => {
      const mine = await portableItem(c, owner);
      const insert = `WITH i AS (INSERT INTO portable_memory_items (owner_user_id, kind, status, superseded_by)
                        VALUES ($1, 'preference', 'superseded', $2) RETURNING id)
                      INSERT INTO portable_memory_item_versions (item_id, version, statement, actor_kind, actor_user_id)
                      SELECT id, 1, 'Old', 'user', $1 FROM i`;
      expect(await code(c, insert, [other, mine])).toBe("23503");
      expect(await code(c, insert, [owner, mine])).toBeUndefined();
    });
  });

  it("deletes run records of every lane with their item, in every Workspace (M2)", async () => {
    const pt = await inTeam(teamA, (c) => portableItem(c, owner), true);
    const st = await inTeam(teamA, (c) => siteItem(c), true);
    for (const [team, runId] of [
      [teamA, runA],
      [teamB, runB],
    ] as const) {
      await inTeam(
        team,
        async (c) => {
          await c.query(
            `INSERT INTO run_portable_memory_items (team_id, run_id, item_id, version) VALUES ($1, $2, $3, 1)`,
            [team, runId, pt],
          );
          await c.query(
            `INSERT INTO run_site_memory_items (team_id, run_id, item_id, version) VALUES ($1, $2, $3, 1)`,
            [team, runId, st],
          );
        },
        true,
      );
    }
    const records = `SELECT (SELECT count(*) FROM run_portable_memory_items WHERE item_id = $1)::int AS p,
                            (SELECT count(*) FROM run_site_memory_items WHERE item_id = $2)::int AS s`;
    expect((await admin.query(records, [pt, st])).rows).toEqual([{ p: 2, s: 2 }]);
    // Deleted from team A's context: the cascade still reaches team B's rows (RI ignores RLS).
    await inTeam(
      teamA,
      async (c) => {
        await c.query(`DELETE FROM portable_memory_items WHERE id = $1`, [pt]);
        await c.query(`DELETE FROM site_memory_items WHERE id = $1`, [st]);
      },
      true,
    );
    expect((await admin.query(records, [pt, st])).rows).toEqual([{ p: 0, s: 0 }]);
  });
});

describe("semantic memory versions are immutable", () => {
  let item = "";
  beforeAll(async () => {
    item = await inTeam(
      teamA,
      async (c) => {
        const id = await wsItem(c, teamA, "user", owner);
        await c.query(
          `INSERT INTO semantic_memory_item_versions
             (team_id, item_id, version, statement, actor_kind, actor_user_id, pass_id, source_thread_id, source_entry_ids, evidence)
           VALUES ($1, $2, 2, 'Prefers short answers', 'pass', $3, $4, $5, '{e1,e2}', '[{"quote":"keep it short"}]')`,
          [teamA, id, owner, randomUUID(), threadA],
        );
        await c.query(
          `UPDATE semantic_memory_items SET current_version = 2 WHERE team_id = $1 AND id = $2`,
          [teamA, id],
        );
        await c.query(
          `INSERT INTO run_memory_items (team_id, run_id, item_id, version) VALUES ($1, $2, $3, 2)`,
          [teamA, runA, id],
        );
        await portableItem(c, owner);
        await siteItem(c);
        return id;
      },
      true,
    );
  });

  it("refuses the retention scrub while a legal hold covers the item", async () => {
    const h = await hold(teamA, owner);
    try {
      await inTeam(teamA, async (c) => {
        const where = `WHERE team_id = '${teamA}' AND item_id = '${item}' AND version = 2`;
        const scrub = `UPDATE semantic_memory_item_versions SET evidence = NULL, source_thread_id = NULL, source_entry_ids = NULL ${where}`;
        expect(await code(c, scrub)).toBe(LEGAL_HOLD_SQLSTATE);
      });
    } finally {
      await release(h);
    }
  });

  it("allows only the retention scrub of provenance on Workspace versions (L4)", async () => {
    await inTeam(teamA, async (c) => {
      const where = `WHERE team_id = '${teamA}' AND item_id = '${item}' AND version = 2`;
      const update = (set: string) =>
        code(c, `UPDATE semantic_memory_item_versions SET ${set} ${where}`);
      expect(await update(`evidence = '[]'`)).toBe("55000");
      expect(await update(`source_thread_id = gen_random_uuid()`)).toBe("55000");
      expect(await update(`statement = 'Prefers long answers'`)).toBe("55000");
      expect(await update(`lint_override = true`)).toBe("55000");
      expect(await update(`pass_id = NULL`)).toBe("55000");
      expect(await update(`evidence = NULL, policy_override = true`)).toBe("55000");
      expect(await update(`evidence = NULL`)).toBeUndefined();
      expect(await update(`source_entry_ids = NULL, source_thread_id = NULL`)).toBeUndefined();
      const { rows } = await c.query(
        `SELECT statement, statement_tsv::text AS tsv, evidence, source_thread_id, source_entry_ids, pass_id IS NOT NULL AS pass
           FROM semantic_memory_item_versions ${where}`,
      );
      expect(rows).toEqual([
        {
          statement: "Prefers short answers",
          tsv: "'answer':3 'prefer':1 'short':2",
          evidence: null,
          source_thread_id: null,
          source_entry_ids: null,
          pass: true,
        },
      ]);
    });
  });

  it("refuses every other UPDATE and direct DELETE, for the app role and the owner", async () => {
    await inTeam(teamA, async (c) => {
      for (const table of VERSION_TABLES) {
        // The app role has no UPDATE or DELETE on the site-wide versions (42501 before the trigger).
        const refused = table === "semantic_memory_item_versions" ? "55000" : "42501";
        expect(await code(c, `UPDATE ${table} SET lint_override = true`), table).toBe(refused);
        expect(await code(c, `DELETE FROM ${table}`), table).toBe(refused);
      }
    });
    await admin.query("BEGIN");
    try {
      for (const table of VERSION_TABLES) {
        expect(await code(admin, `UPDATE ${table} SET lint_override = true`), table).toBe("55000");
        expect(await code(admin, `DELETE FROM ${table}`), table).toBe("55000");
      }
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  it("takes versions and run records with the item", async () => {
    await inTeam(teamA, async (c) => {
      await c.query(`DELETE FROM semantic_memory_items WHERE team_id = $1 AND id = $2`, [
        teamA,
        item,
      ]);
      const left = await c.query(
        `SELECT 1 FROM semantic_memory_item_versions WHERE item_id = $1
         UNION ALL SELECT 1 FROM run_memory_items WHERE item_id = $1`,
        [item],
      );
      expect(left.rows).toEqual([]);
      expect(await code(c, "SELECT 1")).toBeUndefined();
    });
  });
});

describe("semantic memory under legal hold (M1)", () => {
  it("refuses deleting a held owner's items and any team item, and truncating the team tables", async () => {
    const [mine, theirs, shared] = await inTeam(
      teamA,
      async (c) => [
        await wsItem(c, teamA, "user", owner),
        await wsItem(c, teamA, "user", other),
        await wsItem(c, teamA, "team", null),
      ],
      true,
    );
    const h = await hold(teamA, owner);
    try {
      await inTeam(teamA, async (c) => {
        const del = `DELETE FROM semantic_memory_items WHERE team_id = $1 AND id = $2`;
        expect(await code(c, del, [teamA, mine])).toBe(LEGAL_HOLD_SQLSTATE);
        // A team item has no owner: any active hold in its team covers it.
        expect(await code(c, del, [teamA, shared])).toBe(LEGAL_HOLD_SQLSTATE);
        expect(await code(c, del, [teamA, theirs])).toBeUndefined();
      });
      // Another team's items are not covered.
      await inTeam(teamB, async (c) => {
        const b = await wsItem(c, teamB, "team", null);
        const del = `DELETE FROM semantic_memory_items WHERE team_id = $1 AND id = $2`;
        expect(await code(c, del, [teamB, b])).toBeUndefined();
      });
      await admin.query("BEGIN");
      try {
        for (const table of TEAM_TABLES) {
          expect(await code(admin, `TRUNCATE ${table} CASCADE`), table).toBe(LEGAL_HOLD_SQLSTATE);
        }
      } finally {
        await admin.query("ROLLBACK");
      }
    } finally {
      await release(h);
    }
    await inTeam(teamA, async (c) => {
      const del = `DELETE FROM semantic_memory_items WHERE team_id = $1 AND id = ANY($2)`;
      expect(await code(c, del, [teamA, [mine, shared]])).toBeUndefined();
    });
  });
});
