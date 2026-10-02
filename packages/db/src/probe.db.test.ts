import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KobeDatabase } from "./client.js";
import { quoteIdent } from "./roles.js";
import { teams } from "./schema/index.js";
import { TEAM_TABLES } from "./tenancy.js";
import { PROBE_FIXTURES } from "./testing/probe-fixtures/index.js";
import { withTeam } from "./with-team.js";
import { BREAK_GLASS_READABLE_TABLES } from "./break-glass/tables.js";
import { BREAK_GLASS_ACTOR_SETTING, BREAK_GLASS_GRANT_SETTING } from "./settings.js";

/**
 * Cross-team probe suite (ac-2, ac-3). Seeds two teams, then queries every team table as the app
 * role with raw SQL and no app-level filters: anything other than the active team's rows is leakage.
 */
const teamA = randomUUID();
const teamB = randomUUID();
let app: KobeDatabase;
let single: KobeDatabase;

beforeAll(async () => {
  const owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values([
    { id: teamA, slug: `a-${teamA.slice(0, 8)}`, name: "Team A" },
    { id: teamB, slug: `b-${teamB.slice(0, 8)}`, name: "Team B" },
  ]);
  await owner.close();

  app = createDb(inject("appUrl"));
  single = createDb(inject("appUrl"), { max: 1 });
  for (const table of TEAM_TABLES) {
    for (const teamId of [teamA, teamB]) {
      await withTeam(app.db, teamId, (tx) => PROBE_FIXTURES[table](tx, teamId));
    }
  }
});

afterAll(async () => {
  await app.close();
  await single.close();
});

/** Drizzle wraps driver errors; assert on the underlying Postgres RLS violation (SQLSTATE 42501). */
async function expectRlsViolation(promise: Promise<unknown>): Promise<void> {
  const err: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  const cause = (err as { cause?: { code?: string; message?: string } } | undefined)?.cause;
  expect(cause?.code, String(err)).toBe("42501");
  expect(cause?.message).toMatch(/row-level security/);
}

async function teamIdsIn(table: string, teamId: string): Promise<string[]> {
  return withTeam(app.db, teamId, async (tx) => {
    const result = await tx.execute<{ team_id: string }>(
      sql.raw(`SELECT team_id FROM ${quoteIdent(table)}`),
    );
    return result.rows.map((r) => r.team_id);
  });
}

describe.each(TEAM_TABLES)("cross-team probe: %s", (table) => {
  const t = quoteIdent(table);

  it("returns zero rows outside withTeam", async () => {
    const result = await app.pool.query(`SELECT count(*)::int AS n FROM ${t}`);
    expect(result.rows[0]).toEqual({ n: 0 });
  });

  it("returns only the active team's rows inside withTeam", async () => {
    const a = await teamIdsIn(table, teamA);
    const b = await teamIdsIn(table, teamB);
    expect(a.length).toBeGreaterThan(0);
    expect(new Set(a)).toEqual(new Set([teamA]));
    expect(new Set(b)).toEqual(new Set([teamB]));
  });

  it("rejects inserting a row for another team", async () => {
    await expectRlsViolation(withTeam(app.db, teamA, (tx) => PROBE_FIXTURES[table](tx, teamB)));
  });

  it("rejects moving a row to another team", async () => {
    await expectRlsViolation(
      withTeam(app.db, teamA, (tx) => tx.execute(sql.raw(`UPDATE ${t} SET team_id = '${teamB}'`))),
    );
  });

  it("cannot update or delete another team's rows", async () => {
    const counts = await withTeam(app.db, teamA, async (tx) => {
      const updated = await tx.execute(
        sql.raw(`UPDATE ${t} SET team_id = team_id WHERE team_id = '${teamB}'`),
      );
      const deleted = await tx.execute(sql.raw(`DELETE FROM ${t} WHERE team_id = '${teamB}'`));
      return [updated.rowCount, deleted.rowCount];
    });
    expect(counts).toEqual([0, 0]);
    expect((await teamIdsIn(table, teamB)).length).toBeGreaterThan(0);
  });

  it("returns zero rows (not an error) on a pooled connection reused after withTeam", async () => {
    await withTeam(single.db, teamA, (tx) => tx.execute(sql.raw(`SELECT 1 FROM ${t}`)));
    const result = await single.pool.query(`SELECT count(*)::int AS n FROM ${t}`);
    expect(result.rows[0]).toEqual({ n: 0 });
  });
});

/**
 * Break-glass probe (KOBE-16, D10): under an approved grant for team A, raw SQL on every team table
 * sees team A's rows only on the readable tables (and nothing elsewhere), never team B's, and can't
 * write anything. A grant named with the wrong actor, or no longer active, exposes nothing.
 */
describe("break-glass probe", () => {
  let requester = "";
  let grantId = "";

  async function asGrant<T>(
    fn: (tx: Parameters<Parameters<typeof app.db.transaction>[0]>[0]) => Promise<T>,
    actor = requester,
    grant = grantId,
  ): Promise<T> {
    return app.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config(${BREAK_GLASS_GRANT_SETTING}, ${grant}, true),
                   set_config(${BREAK_GLASS_ACTOR_SETTING}, ${actor}, true)`,
      );
      return fn(tx);
    });
  }

  let approver = "";

  /** An approved grant for team A, optionally narrowed (the trigger applies as in production). */
  async function approvedGrant(
    narrow: { userId?: string; threadId?: string } = {},
  ): Promise<string> {
    const { rows } = await app.pool.query<{ id: string }>(
      `INSERT INTO break_glass_grants (team_id, admin_id, user_id, thread_id, reason)
       VALUES ($1, $2, $3, $4, 'probe') RETURNING id`,
      [teamA, requester, narrow.userId ?? null, narrow.threadId ?? null],
    );
    const id = rows[0]?.id ?? "";
    await app.pool.query(
      `UPDATE break_glass_grants SET status = 'approved', approver_id = $2 WHERE id = $1`,
      [id, approver],
    );
    return id;
  }

  const rowsUnder = (grant: string, query: string) =>
    asGrant(
      async (tx) => (await tx.execute<Record<string, string>>(sql.raw(query))).rows,
      requester,
      grant,
    );

  const teamIdsUnderGrant = (table: string, actor?: string) =>
    asGrant(async (tx) => {
      const r = await tx.execute<{ team_id: string }>(
        sql.raw(`SELECT team_id FROM ${quoteIdent(table)}`),
      );
      return r.rows.map((row) => row.team_id);
    }, actor);

  beforeAll(async () => {
    const admins = [randomUUID(), randomUUID()];
    for (const id of admins) {
      await app.pool.query(`INSERT INTO users (id, name, email) VALUES ($1, 'BG', $2)`, [
        id,
        `${id}@probe.test`,
      ]);
      await app.pool.query(`INSERT INTO install_roles (user_id, role) VALUES ($1, 'admin')`, [id]);
    }
    requester = admins[0] ?? "";
    approver = admins[1] ?? "";
    const { rows } = await app.pool.query<{ id: string }>(
      `INSERT INTO break_glass_grants (team_id, admin_id, reason) VALUES ($1, $2, 'probe') RETURNING id`,
      [teamA, requester],
    );
    grantId = rows[0]?.id ?? "";
    await app.pool.query(
      `UPDATE break_glass_grants SET status = 'approved', approver_id = $2 WHERE id = $1`,
      [grantId, admins[1]],
    );
  });

  describe.each(TEAM_TABLES)("%s", (table) => {
    const t = quoteIdent(table);
    const readable = (BREAK_GLASS_READABLE_TABLES as readonly string[]).includes(table);

    it(readable ? "shows only team A's rows" : "shows nothing (not team content)", async () => {
      const ids = await teamIdsUnderGrant(table);
      if (readable) {
        expect(ids.length).toBeGreaterThan(0);
        expect(new Set(ids)).toEqual(new Set([teamA]));
      } else {
        expect(ids).toEqual([]);
      }
    });

    it("shows nothing for another actor naming the grant", async () => {
      expect(await teamIdsUnderGrant(table, randomUUID())).toEqual([]);
    });

    it("can't insert, update or delete in either team", async () => {
      await expectRlsViolation(asGrant((tx) => PROBE_FIXTURES[table](tx, teamA)));
      const counts = await asGrant(async (tx) => {
        const updated = await tx.execute(sql.raw(`UPDATE ${t} SET team_id = team_id`));
        const deleted = await tx.execute(sql.raw(`DELETE FROM ${t}`));
        return [updated.rowCount, deleted.rowCount];
      });
      expect(counts).toEqual([0, 0]);
    });
  });

  describe("scoped grants on the readable tables", () => {
    let subject = "";
    let thread = "";

    beforeAll(async () => {
      // A team A thread that has entries (from the thread_entries fixture), and its owner.
      const [row] = await withTeam(
        app.db,
        teamA,
        async (tx) =>
          (
            await tx.execute<{ thread_id: string; owner: string }>(
              sql`SELECT e.thread_id, t.owner_user_id AS owner FROM thread_entries e
                JOIN threads t ON t.team_id = e.team_id AND t.id = e.thread_id LIMIT 1`,
            )
          ).rows,
      );
      subject = row?.owner ?? "";
      thread = row?.thread_id ?? "";
    });

    it("a user grant shows only that user's threads and their entries", async () => {
      const id = await approvedGrant({ userId: subject });
      const threads = await rowsUnder(id, `SELECT team_id, owner_user_id FROM threads`);
      expect(threads.length).toBeGreaterThan(0);
      expect(threads.every((t) => t.team_id === teamA && t.owner_user_id === subject)).toBe(true);
      const entries = await rowsUnder(id, `SELECT team_id, thread_id FROM thread_entries`);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((e) => e.team_id === teamA && e.thread_id === thread)).toBe(true);
    });

    it("a thread grant shows only that thread and its entries", async () => {
      const id = await approvedGrant({ threadId: thread });
      expect(await rowsUnder(id, `SELECT id FROM threads`)).toEqual([{ id: thread }]);
      const entries = await rowsUnder(id, `SELECT thread_id FROM thread_entries`);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((e) => e.thread_id === thread)).toBe(true);
    });

    it("an expired grant shows nothing, whatever the settings claim", async () => {
      const id = await approvedGrant();
      const admin = new pg.Client({ connectionString: inject("adminUrl") });
      await admin.connect();
      try {
        await admin.query(`SET session_replication_role = replica`);
        await admin.query(
          `UPDATE break_glass_grants SET starts_at = now() - interval '2 hours',
             expires_at = now() - interval '1 second' WHERE id = $1`,
          [id],
        );
      } finally {
        await admin.end();
      }
      for (const table of BREAK_GLASS_READABLE_TABLES) {
        expect(await rowsUnder(id, `SELECT team_id FROM ${quoteIdent(table)}`)).toEqual([]);
      }
    });

    it("a grant stops at its expiry inside a long transaction (per-statement check)", async () => {
      const id = await approvedGrant();
      const admin = new pg.Client({ connectionString: inject("adminUrl") });
      await admin.connect();
      try {
        await admin.query(`SET session_replication_role = replica`);
        await admin.query(
          `UPDATE break_glass_grants SET expires_at = now() + interval '2 seconds' WHERE id = $1`,
          [id],
        );
      } finally {
        await admin.end();
      }
      const [before, after] = await asGrant(
        async (tx) => {
          const first = await tx.execute(sql`SELECT 1 FROM threads`);
          await tx.execute(sql`SELECT pg_sleep(2.5)`);
          const second = await tx.execute(sql`SELECT 1 FROM threads`);
          return [first.rows.length, second.rows.length];
        },
        requester,
        id,
      );
      expect(before).toBeGreaterThan(0);
      expect(after).toBe(0);
    });

    it("sees an approval that committed after the transaction began", async () => {
      const { rows } = await app.pool.query<{ id: string }>(
        `INSERT INTO break_glass_grants (team_id, admin_id, reason) VALUES ($1, $2, 'probe') RETURNING id`,
        [teamA, requester],
      );
      const id = rows[0]?.id ?? "";
      const seen = await asGrant(
        async (tx) => {
          const pending = await tx.execute(sql`SELECT 1 FROM threads`);
          await app.pool.query(
            `UPDATE break_glass_grants SET status = 'approved', approver_id = $2 WHERE id = $1`,
            [id, approver],
          );
          const approved = await tx.execute(sql`SELECT 1 FROM threads`);
          return [pending.rows.length, approved.rows.length];
        },
        requester,
        id,
      );
      expect(seen[0]).toBe(0);
      expect(seen[1]).toBeGreaterThan(0);
    });
  });

  it("exposes nothing once the grant is revoked", async () => {
    const [other] = (
      await app.pool.query<{ user_id: string }>(
        `SELECT user_id FROM install_roles WHERE user_id <> $1 AND role = 'admin' LIMIT 1`,
        [requester],
      )
    ).rows;
    await app.pool.query(
      `UPDATE break_glass_grants SET status = 'revoked', decided_by = $2 WHERE id = $1`,
      [grantId, other?.user_id],
    );
    for (const table of BREAK_GLASS_READABLE_TABLES) {
      expect(await teamIdsUnderGrant(table)).toEqual([]);
    }
  });
});

describe("install-wide tables", () => {
  it("does not let the app role delete teams (FK cascades would bypass RLS)", async () => {
    const err: unknown = await app.pool.query(`DELETE FROM teams WHERE id = $1`, [teamB]).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((err as { code?: string } | undefined)?.code).toBe("42501");
    expect((await teamIdsIn("team_members", teamB)).length).toBeGreaterThan(0);
  });
});

describe("probe suite coverage", () => {
  it("has a fixture for every team table", () => {
    expect(Object.keys(PROBE_FIXTURES).sort()).toEqual([...TEAM_TABLES].sort());
  });
});
