import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KobeDatabase } from "./client.js";
import { recordModelUsage, type ModelUsageRecord } from "./models/index.js";
import { teams, users, type UsageKind } from "./schema/index.js";
import { withTeam } from "./with-team.js";

/**
 * KOBE-327 (SK18): the team eval cap through `kobe_reserve_budget` (0150). The run_usage trigger
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
