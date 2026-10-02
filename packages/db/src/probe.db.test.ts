import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KobeDatabase } from "./client.js";
import { quoteIdent } from "./roles.js";
import { teams } from "./schema/index.js";
import { TEAM_TABLES } from "./tenancy.js";
import { PROBE_FIXTURES } from "./testing/probe-fixtures/index.js";
import { withTeam } from "./with-team.js";

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
