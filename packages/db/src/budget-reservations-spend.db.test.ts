import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KobeDatabase } from "./client.js";
import { recordModelUsage } from "./models/index.js";
import { teams, users } from "./schema/index.js";

/**
 * KOBE-286: `kobe_reserve_budget` judges each line on the spend in the daily counters, read in
 * the same snapshot as the reservations, not on the spend the caller cached. A line without a
 * period (a gateway of the release before) is still judged on its own `spent`.
 */
let app: KobeDatabase;
const team = randomUUID();
const alice = randomUUID();
const bob = randomUUID();
const SALT = "spend-salt";

const line = (scope: string, period: string | undefined, limit: number, spent = 0) => ({
  scope,
  unit: "tokens",
  limit: String(limit),
  spent: String(spent),
  ...(period === undefined ? {} : { period }),
});

const reserve = async (who: string, call: string, tokens: number, lines: unknown[]) =>
  (
    await app.db.execute<{ r: string }>(
      sql`SELECT kobe_reserve_budget(${team}::uuid, ${who}::uuid, ${call}, ${0}::numeric, ${tokens}::bigint,
        ${60_000}::integer, ${0.25}::numeric, ${JSON.stringify(lines)}::jsonb, ${SALT}) AS r`,
    )
  ).rows[0]?.r;

const settle = (calls: string[]) =>
  app.db.execute(
    sql`SELECT kobe_settle_budget(${team}::uuid, ${`{${calls.join(",")}}`}::text[], NULL::integer, ${SALT})`,
  );

/** One ledger row of `tokens` for `who` today (the run_usage trigger counts it). */
const spend = (who: string, tokens: number) =>
  recordModelUsage(app.db, [
    {
      id: randomUUID(),
      teamId: team,
      userId: who,
      sandboxId: randomUUID(),
      runId: undefined,
      at: new Date(),
      route: "openai",
      model: "kobe-unpriced/m",
      status: 200,
      inputTokens: tokens,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      usageSource: "reported",
      durationMs: 1,
      ttfbMs: 1,
      aborted: false,
    },
  ]);

const siteSpentToday = async () =>
  Number(
    (
      await app.db.execute<{ t: string }>(
        sql`SELECT COALESCE(sum(tokens), 0) AS t FROM site_model_spend_daily
             WHERE day >= (clock_timestamp() AT TIME ZONE 'UTC')::date`,
      )
    ).rows[0]?.t ?? 0,
  );

beforeAll(async () => {
  const owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values({ id: team, slug: `sp-${team.slice(0, 8)}`, name: "Sp" });
  await owner.close();
  app = createDb(inject("appUrl"), { max: 4 });
  await app.db.insert(users).values([
    { id: alice, name: "Alice", email: `${alice}@sp.test` },
    { id: bob, name: "Bob", email: `${bob}@sp.test` },
  ]);
  await spend(alice, 300);
  await spend(bob, 200);
});
afterAll(() => app.close());

describe("kobe_reserve_budget reads the spend itself (KOBE-286)", () => {
  it("a member line: the counters' spend counts, the caller's stale spend does not", async () => {
    // Alice spent 300 today; the caller claims 0.
    expect(await reserve(alice, randomUUID(), 10, [line("user", "day", 300, 0)])).toBe("full:0");
    expect(await reserve(alice, randomUUID(), 10, [line("user", "month", 300, 0)])).toBe("full:0");
    // Bob's own line only sees Bob's 200.
    const call = randomUUID();
    expect(await reserve(bob, call, 10, [line("user", "day", 300, 0)])).toBe("ok");
    await settle([call]);
  });

  it("a team line sums every member; a site line the site's counters", async () => {
    expect(await reserve(alice, randomUUID(), 10, [line("team", "day", 500, 0)])).toBe("full:0");
    const call = randomUUID();
    expect(await reserve(alice, call, 10, [line("team", "day", 501, 0)])).toBe("ok");
    await settle([call]);
    const site = await siteSpentToday();
    expect(site).toBeGreaterThanOrEqual(500);
    expect(await reserve(alice, randomUUID(), 10, [line("site", "day", site, 0)])).toBe("full:0");
    const ok = randomUUID();
    expect(await reserve(alice, ok, 10, [line("site", "day", site + 100, 0)])).toBe("ok");
    await settle([ok]);
  });

  it("a written and settled call counts once: in spend, not also as a hold", async () => {
    const who = randomUUID();
    await app.db.insert(users).values({ id: who, name: "C", email: `${who}@sp.test` });
    const lines = [line("user", "day", 150)];
    const x = randomUUID();
    expect(await reserve(who, x, 100, lines)).toBe("ok");
    await spend(who, 100); // X's ledger row lands
    // Until the gateway settles X, it counts twice (spend 100 + hold 100 reach 150)...
    expect(await reserve(who, randomUUID(), 40, lines)).toBe("full:0");
    await settle([x]); // ...and once after: the hold ends at once, the spend stays.
    const y = randomUUID();
    expect(await reserve(who, y, 40, lines)).toBe("ok");
    await settle([y]);
  });

  it("a line without a period (the release before) is judged on its own spend", async () => {
    const call = randomUUID();
    expect(await reserve(alice, call, 10, [line("user", undefined, 300, 0)])).toBe("ok");
    await settle([call]);
    expect(await reserve(alice, randomUUID(), 10, [line("user", undefined, 300, 300)])).toBe(
      "full:0",
    );
  });

  /** The SQLSTATE a reserve with these lines fails with (undefined: it answered). */
  const failure = (lines: unknown[]) =>
    reserve(alice, randomUUID(), 10, lines).then(
      () => undefined,
      (e: unknown) => (e as { cause?: { code?: string } }).cause?.code,
    );

  it.each([
    ["an unknown period", { scope: "user", unit: "tokens", limit: "300", period: "week" }],
    ["an unknown scope", { scope: "galaxy", unit: "tokens", limit: "300", period: "day" }],
    ["no scope", { unit: "tokens", limit: "300", period: "day" }],
    ["an unknown unit", { scope: "user", unit: "eur", limit: "300", period: "day" }],
    ["no unit", { scope: "user", limit: "300", period: "day" }],
    ["no limit", { scope: "user", unit: "tokens", period: "day" }],
    ["a null limit", { scope: "user", unit: "tokens", limit: null, period: "day" }],
    ["a NaN limit", { scope: "user", unit: "tokens", limit: "NaN", period: "day" }],
    ["no period and no spend", { scope: "user", unit: "tokens", limit: "300" }],
    ["a line that is not an object", "site"],
  ])("refuses a malformed line (22023), never admits it: %s", async (_, bad) => {
    // Alone, and after a valid site line (the site pass must not run first and admit).
    expect(await failure([bad])).toBe("22023");
    expect(await failure([line("site", "month", 1e12), bad])).toBe("22023");
  });
});
