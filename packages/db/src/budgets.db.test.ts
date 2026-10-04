import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KobeDatabase } from "./client.js";
import {
  exhaustedLine,
  loadMemberBudgetState,
  loadTeamBudgetLines,
  recordModelUsage,
  type ModelUsageRecord,
} from "./models/index.js";
import {
  installModelLimits,
  installModelSpendDaily,
  modelCatalog,
  modelProviders,
  modelSpendDaily,
  teamBudgets,
  teams,
  users,
} from "./schema/index.js";
import { withTeam } from "./with-team.js";

/** KOBE-42: budgets, the daily spend counters kept by the run_usage trigger, budget state. */
let app: KobeDatabase;
const teamA = randomUUID();
const teamB = randomUUID();
const alice = randomUUID();
const bob = randomUUID();
const provider = `b-${teamA.slice(0, 8)}`;
const model = `kobe-${provider}/m`;
const now = new Date("2026-10-15T12:00:00Z");

const usage = (over: Partial<ModelUsageRecord>): ModelUsageRecord => ({
  teamId: teamA,
  userId: alice,
  sandboxId: randomUUID(),
  runId: undefined,
  at: now,
  route: "openai",
  model,
  status: 200,
  // $1 per call at $1 / 1M input tokens.
  inputTokens: 1_000_000,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  usageSource: "reported",
  durationMs: 1,
  ttfbMs: 1,
  aborted: false,
  ...over,
});

beforeAll(async () => {
  const owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values([
    { id: teamA, slug: `ba-${teamA.slice(0, 8)}`, name: "Budgets A" },
    { id: teamB, slug: `bb-${teamB.slice(0, 8)}`, name: "Budgets B" },
  ]);
  await owner.close();
  app = createDb(inject("appUrl"));
  await app.db.insert(users).values([
    { id: alice, name: "Alice", email: `${alice}@b.test` },
    { id: bob, name: "Bob", email: `${bob}@b.test` },
  ]);
  await app.db.insert(modelProviders).values({
    id: provider,
    kind: "openai_compatible",
    name: "Budgets",
    baseUrl: "http://b.invalid",
    createdBy: alice,
  });
  await app.db.insert(modelCatalog).values({
    alias: `${provider}-m`,
    providerId: provider,
    model: "m",
    inputUsdPerMtok: 1,
    outputUsdPerMtok: 1,
    createdBy: alice,
  });
});
afterAll(() => app.close());

describe("daily spend counters (run_usage trigger)", () => {
  it("adds every inserted call to the team's (day, user) row and the install's day", async () => {
    const before = await app.db
      .select()
      .from(installModelSpendDaily)
      .where(eq(installModelSpendDaily.day, "2026-10-15"));
    await recordModelUsage(app.db, [
      usage({}),
      usage({}),
      usage({ userId: bob }),
      usage({ at: new Date("2026-10-14T23:59:59Z") }),
      usage({ teamId: teamB, userId: bob }),
    ]);
    const rows = await withTeam(app.db, teamA, (tx) =>
      tx.select().from(modelSpendDaily).where(eq(modelSpendDaily.teamId, teamA)),
    );
    const byKey = Object.fromEntries(
      rows.map((r) => [`${r.day}:${r.userId === alice ? "alice" : "bob"}`, [r.costUsd, r.calls]]),
    );
    expect(byKey).toEqual({
      "2026-10-15:alice": [2, 2],
      "2026-10-15:bob": [1, 1],
      "2026-10-14:alice": [1, 1],
    });
    const [day] = await app.db
      .select()
      .from(installModelSpendDaily)
      .where(eq(installModelSpendDaily.day, "2026-10-15"));
    expect((day?.costUsd ?? 0) - (before[0]?.costUsd ?? 0)).toBeCloseTo(4, 6);
    // Another team's counters stay behind its RLS.
    const seenByB = await withTeam(app.db, teamB, (tx) => tx.select().from(modelSpendDaily));
    expect(seenByB.every((r) => r.teamId === teamB)).toBe(true);
  });
});

describe("budget state", () => {
  it("lists install, team and member budgets with their period's spend; the widest used-up one stops", async () => {
    await app.db
      .update(installModelLimits)
      .set({ monthlyUsd: 1_000_000, userRequestsPerMinute: 100 })
      .where(eq(installModelLimits.id, 1));
    await withTeam(app.db, teamA, (tx) =>
      tx.insert(teamBudgets).values([
        { teamId: teamA, monthlyUsd: 10, dailyUsd: 3, userRequestsPerMinute: 20, updatedBy: bob },
        { teamId: teamA, userId: alice, monthlyUsd: 5, updatedBy: bob },
        { teamId: teamA, userId: bob, dailyUsd: 100, updatedBy: bob },
      ]),
    );
    const team = await withTeam(app.db, teamA, (tx) => loadTeamBudgetLines(tx, teamA, now));
    expect(team.requestsPerMinute).toBe(20);
    const view = team.lines.map((l) => [l.scope, l.period, l.limitUsd, l.spentUsd]);
    expect(view).toEqual(
      expect.arrayContaining([
        ["team", "month", 10, 4],
        ["team", "day", 3, 3],
        ["user", "month", 5, 3],
        ["user", "day", 100, 1],
      ]),
    );
    const aliceState = await withTeam(app.db, teamA, (tx) =>
      loadMemberBudgetState(tx, teamA, alice, now),
    );
    // Alice sees the install's, the team's and her own budget, not Bob's.
    expect(aliceState.lines.filter((l) => l.scope === "user")).toHaveLength(1);
    // The team's daily budget ($3) is used up today: the team level stops (wider than Alice's).
    expect(exhaustedLine(aliceState.lines)).toMatchObject({ scope: "team", period: "day" });
    // Tomorrow, only the month counts: $4 of $10.
    const tomorrow = await withTeam(app.db, teamA, (tx) =>
      loadMemberBudgetState(tx, teamA, alice, new Date("2026-10-16T00:00:01Z")),
    );
    expect(exhaustedLine(tomorrow.lines)).toBeUndefined();
  });

  it("allows only one team budget and one budget per member; a member budget has no rate", async () => {
    const err = await withTeam(app.db, teamA, (tx) =>
      tx.insert(teamBudgets).values({ teamId: teamA, monthlyUsd: 1, updatedBy: bob }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const rate = await withTeam(app.db, teamB, (tx) =>
      tx.insert(teamBudgets).values({
        teamId: teamB,
        userId: bob,
        userRequestsPerMinute: 5,
        updatedBy: bob,
      }),
    ).catch((e: unknown) => e);
    expect(rate).toBeInstanceOf(Error);
  });
});
