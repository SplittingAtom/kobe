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
  budgetAlertEmails,
  budgetAlerts,
  installModelLimits,
  installRoles,
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
  // Alice is an install admin (install limits are changed by one, KOBE-42 review).
  await app.db.insert(users).values([
    { id: alice, name: "Alice", email: `${alice}@b.test` },
    { id: bob, name: "Bob", email: `${bob}@b.test` },
  ]);
  await app.db.insert(installRoles).values({ userId: alice, role: "admin" });
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
      rows.map((r) => [
        `${r.day}:${r.userId === alice ? "alice" : "bob"}`,
        [r.costUsd, r.tokens, r.calls],
      ]),
    );
    // Tokens: input + output + cache reads + cache writes (here 1M input per call).
    expect(byKey).toEqual({
      "2026-10-15:alice": [2, 2_000_000, 2],
      "2026-10-15:bob": [1, 1_000_000, 1],
      "2026-10-14:alice": [1, 1_000_000, 1],
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
      .set({ monthlyUsd: 1_000_000, userRequestsPerMinute: 100, updatedBy: alice })
      .where(eq(installModelLimits.id, 1));
    await withTeam(app.db, teamA, (tx) =>
      tx.insert(teamBudgets).values([
        {
          teamId: teamA,
          monthlyUsd: 10,
          dailyUsd: 3,
          monthlyTokens: 50_000_000,
          userRequestsPerMinute: 20,
          updatedBy: bob,
        },
        { teamId: teamA, userId: alice, monthlyUsd: 5, updatedBy: bob },
        { teamId: teamA, userId: bob, dailyUsd: 100, updatedBy: bob },
      ]),
    );
    const team = await withTeam(app.db, teamA, (tx) => loadTeamBudgetLines(tx, teamA, now));
    expect(team.requestsPerMinute).toBe(20);
    const view = team.lines.map((l) => [l.scope, l.period, l.unit, l.limit, l.spent]);
    expect(view).toEqual(
      expect.arrayContaining([
        ["team", "month", "usd", 10, 4],
        ["team", "day", "usd", 3, 3],
        ["team", "month", "tokens", 50_000_000, 4_000_000],
        ["user", "month", "usd", 5, 3],
        ["user", "day", "usd", 100, 1],
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

  it("a token budget caps a model without prices (user decision 2026-10-04)", async () => {
    const team = randomUUID();
    const owner = createDb(inject("ownerUrl"));
    await owner.db.insert(teams).values({ id: team, slug: `bt-${team.slice(0, 8)}`, name: "T" });
    await owner.close();
    await withTeam(app.db, team, (tx) =>
      tx
        .insert(teamBudgets)
        .values({ teamId: team, monthlyUsd: 100, dailyTokens: 1_500, updatedBy: bob }),
    );
    // An unpriced model: no cost, but every token counts (cache reads and writes too).
    await recordModelUsage(app.db, [
      usage({
        teamId: team,
        model: "kobe-unpriced/m",
        inputTokens: 500,
        outputTokens: 400,
        cacheReadTokens: 500,
        cacheWriteTokens: 100,
      }),
    ]);
    const state = await withTeam(app.db, team, (tx) => loadMemberBudgetState(tx, team, alice, now));
    expect(exhaustedLine(state.lines)).toMatchObject({
      scope: "team",
      unit: "tokens",
      period: "day",
      limit: 1_500,
      spent: 1_500,
    });
    // The dollar budget is untouched by the unpriced model.
    expect(state.lines.find((l) => l.unit === "usd" && l.scope === "team")?.spent).toBe(0);
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

describe("integrity against the app role (KOBE-42 review)", () => {
  const code = (e: unknown) => (e as { cause?: { code?: string } }).cause?.code;
  const refused = (p: Promise<unknown>) => p.then(() => undefined, code);
  const today = new Date().toISOString().slice(0, 10);
  const month = `${today.slice(0, 8)}01`;

  it("spend counters accept only the run_usage trigger's writes", async () => {
    expect(
      await refused(
        withTeam(app.db, teamA, (tx) =>
          tx.insert(modelSpendDaily).values({ teamId: teamA, day: today, userId: alice }),
        ),
      ),
    ).toBe("42501");
    expect(
      await refused(
        withTeam(app.db, teamA, (tx) =>
          tx.update(modelSpendDaily).set({ costUsd: 0 }).where(eq(modelSpendDaily.teamId, teamA)),
        ),
      ),
    ).toBe("42501");
    expect(
      await refused(
        withTeam(app.db, teamA, (tx) =>
          tx.delete(modelSpendDaily).where(eq(modelSpendDaily.teamId, teamA)),
        ),
      ),
    ).toBe("42501");
    expect(await refused(app.db.update(installModelSpendDaily).set({ costUsd: 0 }))).toBe("42501");
    expect(await refused(app.db.delete(installModelSpendDaily))).toBe("42501");
  });

  it("an alert is recorded only for a configured budget really crossed in the current period", async () => {
    const team = randomUUID();
    const owner = createDb(inject("ownerUrl"));
    await owner.db.insert(teams).values({ id: team, slug: `bi-${team.slice(0, 8)}`, name: "I" });
    await owner.close();
    await withTeam(app.db, team, (tx) =>
      tx.insert(teamBudgets).values({ teamId: team, dailyTokens: 1_000, updatedBy: bob }),
    );
    const alert = (over: Partial<typeof budgetAlerts.$inferInsert>) =>
      withTeam(app.db, team, (tx) =>
        tx.insert(budgetAlerts).values({
          teamId: team,
          scope: "team",
          unit: "tokens",
          period: "day",
          periodStart: today,
          threshold: 100,
          limitAmount: 1_000,
          spentAmount: 1_000_000,
          ...over,
        }),
      );
    // Not crossed (the counters say 0, whatever the row claims): refused.
    expect(await refused(alert({}))).toBe("23514");
    // A limit that is not the configured one, a period that is not the current one: refused.
    await recordModelUsage(app.db, [usage({ teamId: team, at: new Date(), inputTokens: 1_200 })]);
    expect(await refused(alert({ limitAmount: 1 }))).toBe("23514");
    expect(await refused(alert({ periodStart: "2099-01-01" }))).toBe("23514");
    expect(await refused(alert({ period: "month", periodStart: month }))).toBe("23514");
    // Another team's context: refused.
    expect(
      await refused(
        withTeam(app.db, teamB, (tx) =>
          tx.insert(budgetAlerts).values({
            teamId: team,
            scope: "team",
            unit: "tokens",
            period: "day",
            periodStart: today,
            threshold: 100,
            limitAmount: 1_000,
            spentAmount: 0,
          }),
        ),
      ),
    ).toBeDefined();
    // Really crossed: recorded, with the real spend, and its emails made by the trigger.
    await alert({ spentAmount: 0 });
    const [row] = await withTeam(app.db, team, (tx) =>
      tx.select().from(budgetAlerts).where(eq(budgetAlerts.teamId, team)),
    );
    expect(row?.spentAmount).toBe(1_200);
    // The app cannot queue an email itself.
    expect(
      await refused(
        withTeam(app.db, team, (tx) =>
          tx.insert(budgetAlertEmails).values({ alertId: row?.id ?? "", recipientId: alice }),
        ),
      ),
    ).toBe("42501");
    // Another team does not see it.
    const seenByB = await withTeam(app.db, teamB, (tx) =>
      tx.select().from(budgetAlerts).where(eq(budgetAlerts.teamId, team)),
    );
    expect(seenByB).toEqual([]);
  });

  it("the install limits are changed by an install admin only", async () => {
    expect(
      await refused(app.db.update(installModelLimits).set({ monthlyUsd: null, updatedBy: bob })),
    ).toBe("42501");
    await app.db.update(installModelLimits).set({ monthlyUsd: null, updatedBy: alice });
  });
});
