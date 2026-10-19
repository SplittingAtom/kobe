import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KobeDatabase } from "./client.js";
import { recordModelUsage, type ModelUsageRecord } from "./models/index.js";
import { teams, users, type UsageKind } from "./schema/index.js";
import { withTeam } from "./with-team.js";

/**
 * KOBE-327 (SK18): the team eval cap through `kobe_reserve_budget` (0148). The run_usage trigger
 * counts kinds `eval` and `eval_judge` into `model_spend_daily.eval_*`; an `eval` line is judged
 * on that spend and the other eval calls' live reservations, atomically under the team lock, and
 * ordinary calls neither count against it nor are judged by it.
 */
let app: KobeDatabase;
const team = randomUUID();
const alice = randomUUID();
const bob = randomUUID();
const SALT = "eval-salt";

const evalLine = (limit: number) => ({
  scope: "eval",
  unit: "tokens",
  period: "month",
  limit: String(limit),
  spent: "0",
});
const teamLine = (limit: number) => ({
  scope: "team",
  unit: "tokens",
  period: "month",
  limit: String(limit),
  spent: "0",
});

const reserve = async (who: string, call: string, tokens: number, lines: unknown[]) =>
  (
    await app.db.execute<{ r: string }>(
      sql`SELECT kobe_reserve_budget(${team}::uuid, ${who}::uuid, ${call}, ${0}::numeric, ${tokens}::bigint,
        ${60_000}::integer, ${1}::numeric, ${JSON.stringify(lines)}::jsonb, ${SALT}) AS r`,
    )
  ).rows[0]?.r;
const settle = (calls: string[]) =>
  app.db.execute(
    sql`SELECT kobe_settle_budget(${team}::uuid, ${`{${calls.join(",")}}`}::text[], NULL::integer, ${SALT})`,
  );

const usage = (who: string, tokens: number, kind: UsageKind): ModelUsageRecord => ({
  id: randomUUID(),
  teamId: team,
  userId: who,
  sandboxId: kind === "eval_judge" ? undefined : randomUUID(),
  runId: randomUUID(),
  kind,
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
});

beforeAll(async () => {
  const owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values({ id: team, slug: `ev-${team.slice(0, 8)}`, name: "Ev" });
  await owner.close();
  app = createDb(inject("appUrl"), { max: 4 });
  await app.db.insert(users).values([
    { id: alice, name: "Alice", email: `${alice}@ev.test` },
    { id: bob, name: "Bob", email: `${bob}@ev.test` },
  ]);
  // 1000 ordinary tokens, 300 eval and 100 eval judge tokens this month.
  await recordModelUsage(app.db, [
    usage(alice, 1000, "run"),
    usage(alice, 300, "eval"),
    usage(bob, 100, "eval_judge"),
  ]);
});
afterAll(() => app.close());

describe("the team eval cap in kobe_reserve_budget (KOBE-327)", () => {
  it("counts only the eval kinds into the eval spend", async () => {
    const rows = await withTeam(app.db, team, (tx) =>
      tx.execute<{ tokens: string; eval_tokens: string }>(
        sql`SELECT sum(tokens) AS tokens, sum(eval_tokens) AS eval_tokens FROM model_spend_daily
             WHERE team_id = ${team}::uuid`,
      ),
    );
    expect(rows.rows[0]).toMatchObject({ tokens: "1400", eval_tokens: "400" });
  });

  it("judges an eval line on the eval spend alone, and holds eval reservations against it", async () => {
    expect(await reserve(alice, randomUUID(), 10, [evalLine(400)])).toBe("full:0");
    // The team line sees all 1400; the eval line only 400.
    const first = randomUUID();
    expect(await reserve(alice, first, 50, [teamLine(10_000), evalLine(500)])).toBe("ok");
    // 400 spent and Alice's eval call holding 50: Bob's 60 more reach a cap of 450.
    expect(await reserve(bob, randomUUID(), 60, [evalLine(450)])).toBe("full:0");
    const reserved = await withTeam(app.db, team, (tx) =>
      tx.execute<{ eval: boolean }>(
        sql`SELECT eval FROM budget_reservations WHERE team_id = ${team}::uuid AND call_id = ${first}`,
      ),
    );
    expect(reserved.rows).toEqual([{ eval: true }]);
    await settle([first]);
    const again = randomUUID();
    expect(await reserve(bob, again, 60, [evalLine(450)])).toBe("ok");
    await settle([again]);
  });

  it("never counts an ordinary call's reservation against the eval cap", async () => {
    const ordinary = randomUUID();
    expect(await reserve(alice, ordinary, 5_000, [teamLine(100_000)])).toBe("ok");
    const flag = await withTeam(app.db, team, (tx) =>
      tx.execute<{ eval: boolean }>(
        sql`SELECT eval FROM budget_reservations WHERE team_id = ${team}::uuid AND call_id = ${ordinary}`,
      ),
    );
    expect(flag.rows).toEqual([{ eval: false }]);
    const call = randomUUID();
    expect(await reserve(bob, call, 10, [evalLine(500)])).toBe("ok");
    await settle([ordinary, call]);
  });

  it("refuses an unknown scope as before", async () => {
    await expect(
      reserve(alice, randomUUID(), 1, [{ ...evalLine(10), scope: "evals" }]),
    ).rejects.toMatchObject({ cause: { code: "22023" } });
  });
});

describe("the team eval cap: concurrency, periods, shares, settle (KOBE-327 review L5)", () => {
  const t2 = randomUUID();
  let other: KobeDatabase;
  const reserveIn = async (
    db: KobeDatabase,
    who: string,
    call: string,
    tokens: number,
    lines: unknown[],
    share = 1,
  ) =>
    (
      await db.db.execute<{ r: string }>(
        sql`SELECT kobe_reserve_budget(${t2}::uuid, ${who}::uuid, ${call}, ${0}::numeric, ${tokens}::bigint,
          ${60_000}::integer, ${share}::numeric, ${JSON.stringify(lines)}::jsonb, ${SALT}) AS r`,
      )
    ).rows[0]?.r;
  const settleIn = (calls: string[], keepMs: number | null) =>
    app.db.execute(
      sql`SELECT kobe_settle_budget(${t2}::uuid, ${`{${calls.join(",")}}`}::text[], ${keepMs}::integer, ${SALT})`,
    );
  const row = (who: string, tokens: number, at: Date): ModelUsageRecord => ({
    ...usage(who, tokens, "eval"),
    teamId: t2,
    at,
  });

  beforeAll(async () => {
    const owner = createDb(inject("ownerUrl"));
    await owner.db.insert(teams).values({ id: t2, slug: `ec-${t2.slice(0, 8)}`, name: "Ec" });
    await owner.close();
    other = createDb(inject("appUrl"), { max: 2 });
    const now = new Date();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
    // 500 eval tokens last month (never counted), 100 this month.
    await recordModelUsage(app.db, [row(alice, 500, lastMonth), row(alice, 100, now)]);
  });
  afterAll(() => other.close());

  it("counts this UTC month's eval spend only, and today's on a day line", async () => {
    const ok = randomUUID();
    expect(await reserveIn(app, alice, ok, 1, [evalLine(101)])).toBe("ok");
    await settleIn([ok], null);
    expect(await reserveIn(app, alice, randomUUID(), 1, [evalLine(100)])).toBe("full:0");
    const day = { ...evalLine(100), period: "day" };
    expect(await reserveIn(app, alice, randomUUID(), 1, [day])).toBe("full:0");
  });

  it("admits exactly one of two calls racing for the last of the cap from two connections", async () => {
    // 100 spent, cap 140: the first call holds 40, which fills the line for the second.
    const calls = [randomUUID(), randomUUID()];
    const verdicts = await Promise.all([
      reserveIn(app, alice, must(calls[0]), 40, [evalLine(140)]),
      reserveIn(other, bob, must(calls[1]), 40, [evalLine(140)]),
    ]);
    // Serialised by the team lock: one is admitted, the other refused (the line full, or the
    // admitted call holding all that is left).
    expect(verdicts.filter((v) => v === "ok")).toHaveLength(1);
    expect(verdicts.find((v) => v !== "ok")).toMatch(/^(full|own_share):0$/);
    await settleIn(calls, null);
  });

  it("caps one member's share of what is left while another member's eval call is in flight", async () => {
    // 100 spent, cap 500: 400 left, a quarter (100) per member while others hold some.
    const bobs = randomUUID();
    expect(await reserveIn(app, bob, bobs, 50, [evalLine(500)], 0.25)).toBe("ok");
    expect(await reserveIn(app, alice, randomUUID(), 150, [evalLine(500)], 0.25)).toBe(
      "own_share:0",
    );
    const fits = randomUUID();
    expect(await reserveIn(app, alice, fits, 90, [evalLine(500)], 0.25)).toBe("ok");
    await settleIn([bobs, fits], null);
  });

  it("keeps a settled eval call counting for keep_ms, then frees it", async () => {
    const call = randomUUID();
    expect(await reserveIn(app, alice, call, 30, [evalLine(140)])).toBe("ok");
    await settleIn([call], 60_000);
    expect(await reserveIn(app, bob, randomUUID(), 1, [evalLine(130)])).toBe("full:0");
    await settleIn([call], null);
    const free = randomUUID();
    expect(await reserveIn(app, bob, free, 1, [evalLine(130)])).toBe("ok");
    await settleIn([free], null);
  });
});

function must<T>(x: T | undefined): T {
  if (x === undefined) throw new Error("missing");
  return x;
}
