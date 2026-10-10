import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KobeDatabase } from "./client.js";
import { teams } from "./schema/index.js";
import { withTeam } from "./with-team.js";

/**
 * KOBE-120: shared budget reservations. `kobe_reserve_budget` is atomic against concurrent
 * reservers (several connections, as several gateway replicas), expired rows never count (ac-2),
 * a crashed replica's reservations expire by themselves (ac-1), and settle ends them.
 */
let app: KobeDatabase;
const teamA = randomUUID();
const teamB = randomUUID();
const user = randomUUID();
const other = randomUUID();

const line = (scope: string, unit: string, limit: number, spent = 0) => ({
  scope,
  unit,
  limit: String(limit),
  spent: String(spent),
});

async function reserve(
  team: string,
  who: string,
  call: string,
  tokens: number,
  lines: unknown[],
  ttlMs = 60_000,
  share = 0.25,
): Promise<string> {
  const r = await app.db.execute<{ r: string }>(
    sql`SELECT kobe_reserve_budget(${team}::uuid, ${who}::uuid, ${call}, ${0}::numeric, ${tokens}::bigint,
      ${ttlMs}::integer, ${share}::numeric, ${JSON.stringify(lines)}::jsonb) AS r`,
  );
  return r.rows[0]?.r ?? "";
}

const settle = async (team: string, calls: string[], keepMs: number | null) =>
  (
    await app.db.execute<{ n: number }>(
      sql`SELECT kobe_settle_budget(${team}::uuid, ${calls}::text[], ${keepMs}::integer) AS n`,
    )
  ).rows[0]?.n;

const count = (team: string) =>
  withTeam(app.db, team, async (tx) =>
    Number(
      (await tx.execute<{ n: string }>(sql`SELECT count(*) AS n FROM budget_reservations`)).rows[0]
        ?.n,
    ),
  );

beforeAll(async () => {
  const owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values([
    { id: teamA, slug: `ra-${teamA.slice(0, 8)}`, name: "Res A" },
    { id: teamB, slug: `rb-${teamB.slice(0, 8)}`, name: "Res B" },
  ]);
  await owner.close();
  app = createDb(inject("appUrl"), { max: 10 });
});

afterAll(async () => {
  await app.db.execute(sql`DELETE FROM install_budget_reservations`);
  await app.close();
});

describe("kobe_reserve_budget", () => {
  it("admits within the budget and refuses once spend plus reservations reach it", async () => {
    const lines = [line("team", "tokens", 1000)];
    // share of 1000 left = 250 per member: the first call holds 200.
    expect(await reserve(teamA, user, randomUUID(), 200, lines)).toBe("ok");
    // The same member's next 200 would pass the 250 share.
    expect(await reserve(teamA, user, randomUUID(), 200, lines)).toBe("own_share:0");
    // A user line has no share: only the total counts.
    const own = [line("user", "tokens", 300)];
    expect(await reserve(teamA, user, randomUUID(), 100, own)).toBe("ok");
    expect(await reserve(teamA, user, randomUUID(), 100, own)).toBe("ok");
    expect(await reserve(teamA, user, randomUUID(), 1, own)).toBe("ok");
    expect(await reserve(teamA, user, randomUUID(), 1, [line("user", "tokens", 300, 0)])).toBe(
      "full:0",
    );
  });

  it("two connections cannot both reserve the last amount (atomic)", async () => {
    const lines = [line("user", "tokens", 100)];
    const who = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => reserve(teamB, who, randomUUID(), 100, lines)),
    );
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "full:0")).toHaveLength(7);
  });

  it("an expired reservation does not count before any sweep (ac-2) and a crash frees it (ac-1)", async () => {
    const who = randomUUID();
    const lines = [line("user", "tokens", 100)];
    // A replica reserves with a 100 ms expiry and then "crashes": nothing settles it.
    expect(await reserve(teamA, who, randomUUID(), 100, lines, 100)).toBe("ok");
    expect(await reserve(teamA, who, randomUUID(), 100, lines, 100)).toBe("full:0");
    await new Promise((r) => setTimeout(r, 250));
    expect(await reserve(teamA, who, randomUUID(), 100, lines)).toBe("ok");
    // The expired row is still there (no sweeper ran) yet did not count.
    expect(await count(teamA)).toBeGreaterThan(1);
  });

  it("counts the install line across teams, with the install-wide rows", async () => {
    await app.db.execute(sql`DELETE FROM install_budget_reservations`);
    const lines = [line("install", "tokens", 100)];
    expect(await reserve(teamA, randomUUID(), randomUUID(), 20, lines, 60_000, 1)).toBe("ok");
    expect(await reserve(teamB, randomUUID(), randomUUID(), 80, lines, 60_000, 1)).toBe("full:0");
  });

  it("a repeated call id replaces its reservation", async () => {
    const call = randomUUID();
    const lines = [line("user", "tokens", 100)];
    const who = randomUUID();
    expect(await reserve(teamA, who, call, 100, lines)).toBe("ok");
    expect(await reserve(teamA, who, call, 100, lines)).toBe("ok");
  });

  it("is confined to the team in force", async () => {
    const err = await withTeam(app.db, teamA, (tx) =>
      tx.execute(
        sql`SELECT kobe_reserve_budget(${teamB}::uuid, ${other}::uuid, 'x', 0, 1, 1000, 0.25, '[]'::jsonb)`,
      ),
    ).then(
      () => undefined,
      (e: unknown) => e as { cause?: { code?: string } },
    );
    expect(err?.cause?.code).toBe("42501");
  });
});

describe("kobe_settle_budget", () => {
  it("deletes on settle and shortens the expiry when a write is pending", async () => {
    const who = randomUUID();
    const lines = [line("user", "tokens", 1000)];
    const a = randomUUID();
    const b = randomUUID();
    await reserve(teamB, who, a, 10, lines);
    await reserve(teamB, who, b, 10, lines);
    const before = await count(teamB);
    expect(await settle(teamB, [a], null)).toBe(1);
    expect(await count(teamB)).toBe(before - 1);
    // Shortened: kept for 50 ms, then no longer counted.
    expect(await settle(teamB, [b], 50)).toBe(1);
    await new Promise((r) => setTimeout(r, 150));
    const tight = [line("user", "tokens", 10)];
    expect(await reserve(teamB, who, randomUUID(), 10, tight)).toBe("ok");
  });
});
