import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KobeDatabase } from "./client.js";
import { recordModelUsage, type ModelUsageRecord } from "./models/index.js";
import { teams, users, type UsageKind } from "./schema/index.js";

/**
 * KOBE-443: `kobe_reserve_budget` counts every live hold in full. Before, each member's holds
 * counted only up to the member share of what is left; since the spend is read fresh (KOBE-286)
 * that share shrinks while calls are in flight, so holds taken at a larger share were undercounted
 * and a call was admitted although spend plus the live holds already passed the limit (the
 * two-replica overshoot of PR #317's merge queue: limit 683, 12 calls of 65 admitted).
 *
 * One connection, no timing: holds are taken at spend 0, part of the wave lands and settles, then
 * the next reservation must be refused.
 */
let app: KobeDatabase;
const SALT = "full-holds-salt";
const CALL = 65;
const LIMIT = 683;
const MEMBERS = 8;

interface Fixture {
  readonly team: string;
  readonly members: readonly string[];
}

const line = (scope: string, limit: number) => ({
  scope,
  unit: "tokens",
  period: "day",
  limit: String(limit),
  spent: "0",
});

const reserve = async (f: Fixture, who: string, call: string, lines: unknown[]) =>
  (
    await app.db.execute<{ r: string }>(
      sql`SELECT kobe_reserve_budget(${f.team}::uuid, ${who}::uuid, ${call}, ${0}::numeric,
        ${CALL}::bigint, ${60_000}::integer, ${0.25}::numeric, ${JSON.stringify(lines)}::jsonb,
        ${SALT}) AS r`,
    )
  ).rows[0]?.r;

const settle = (f: Fixture, calls: readonly string[]) =>
  app.db.execute(
    sql`SELECT kobe_settle_budget(${f.team}::uuid, ${`{${calls.join(",")}}`}::text[],
      NULL::integer, ${SALT})`,
  );

const usage = (f: Fixture, who: string, kind: UsageKind): ModelUsageRecord => ({
  id: randomUUID(),
  teamId: f.team,
  userId: who,
  sandboxId: randomUUID(),
  runId: randomUUID(),
  kind,
  at: new Date(),
  route: "openai",
  model: "kobe-unpriced/m",
  status: 200,
  inputTokens: CALL,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  usageSource: "reported",
  durationMs: 1,
  ttfbMs: 1,
  aborted: false,
});

const siteSpentToday = async () =>
  Number(
    (
      await app.db.execute<{ t: string }>(
        sql`SELECT COALESCE(sum(tokens), 0) AS t FROM site_model_spend_daily
             WHERE day >= (clock_timestamp() AT TIME ZONE 'UTC')::date`,
      )
    ).rows[0]?.t ?? 0,
  );

async function fixture(): Promise<Fixture> {
  const team = randomUUID();
  const owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values({ id: team, slug: `fh-${team.slice(0, 8)}`, name: "Fh" });
  await owner.close();
  const members = Array.from({ length: MEMBERS }, () => randomUUID());
  await app.db
    .insert(users)
    .values(members.map((id) => ({ id, name: "M", email: `${id}@fh.test` })));
  return { team, members };
}

/**
 * The wave: at spend 0 (share 170.75) members a, b and c hold two calls each and five others one,
 * 11 calls in all (715 >= 683, so a 12th is refused). The five single calls land and settle, then
 * one of c's: 390 spent, a, b and c still hold 130 + 130 + 65 = 325, true exposure 715. Share is
 * now (683 - 390) x 0.25 = 73.25: capped, a's and b's holds counted 73.25 each (601.5 < 683) and
 * a member with no hold of its own (d) was admitted. Returns that last verdict.
 */
async function wave(f: Fixture, lines: unknown[], kind: UsageKind): Promise<string | undefined> {
  const [a, b, c, d, e, g, h, i] = f.members as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const held: { who: string; call: string }[] = [];
  for (const who of [a, a, b, b, c, c, d, e, g, h, i]) {
    const call = randomUUID();
    expect(await reserve(f, who, call, lines)).toBe("ok");
    held.push({ who, call });
  }
  expect(await reserve(f, i, randomUUID(), lines)).toMatch(/^(full|own_share):0$/);
  const cFirst = held[4];
  if (cFirst === undefined) throw new Error("fixture");
  const landing = [...held.filter((x) => ![a, b, c].includes(x.who)), cFirst];
  expect(landing.map((x) => x.who)).toEqual([d, e, g, h, i, c]);
  for (const x of landing) {
    await recordModelUsage(app.db, [usage(f, x.who, kind)]);
    await settle(f, [x.call]);
  }
  return reserve(f, d, randomUUID(), lines);
}

beforeAll(() => {
  app = createDb(inject("appUrl"), { max: 2 });
});
afterAll(() => app.close());

describe("kobe_reserve_budget counts live holds in full (KOBE-443)", () => {
  it("a team line: holds taken at a larger share still count after spend grew", async () => {
    const f = await fixture();
    expect(await wave(f, [line("team", LIMIT)], "run")).toBe("full:0");
  });

  it("a site line: the same, with the site-wide member keys", async () => {
    const f = await fixture();
    const limit = (await siteSpentToday()) + LIMIT;
    expect(await wave(f, [line("site", limit)], "run")).toBe("full:0");
  });

  it("the team eval cap: the same, on eval spend and eval holds", async () => {
    const f = await fixture();
    const evalLine = { ...line("eval", LIMIT), period: "month" };
    expect(await wave(f, [evalLine], "eval")).toBe("full:0");
  });

  it("keeps the KOBE-120 properties: invoker's rights, pinned search_path", async () => {
    const [fn] = (
      await app.db.execute<{ definer: boolean; config: string[] | null }>(
        sql`SELECT p.prosecdef AS definer, p.proconfig AS config FROM pg_proc p
             WHERE p.oid = 'public.kobe_reserve_budget'::regproc`,
      )
    ).rows;
    expect(fn?.definer).toBe(false);
    expect(fn?.config).toEqual(["search_path=pg_catalog, public"]);
  });

  it("still refuses a different team in force", async () => {
    const f = await fixture();
    const other = randomUUID();
    const err = await app.db
      .transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('kobe.team_id', ${other}, true)`);
        await tx.execute(
          sql`SELECT kobe_reserve_budget(${f.team}::uuid, ${f.members[0]}::uuid, 'x', 0::numeric,
            1::bigint, 60000, 0.25::numeric, ${JSON.stringify([line("team", 10)])}::jsonb, ${SALT})`,
        );
      })
      .then(
        () => undefined,
        (e: unknown) => e as Error & { cause?: { code?: string; message?: string } },
      );
    expect(err?.cause?.code).toBe("42501");
    expect(err?.cause?.message).toMatch(/another team is in force/);
  });
});
