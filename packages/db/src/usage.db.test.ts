import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KobeDatabase } from "./client.js";
import { recordModelUsage, type ModelUsageRecord } from "./models/index.js";
import {
  modelCatalog,
  modelProviders,
  runUsage,
  runs,
  teamMembers,
  teams,
  threads,
  users,
} from "./schema/index.js";
import { withTeam } from "./with-team.js";

/** KOBE-43: the run_usage ledger (team table, RLS), costs at catalog prices, run attribution. */
let app: KobeDatabase;
const teamA = randomUUID();
const teamB = randomUUID();
const userId = randomUUID();
const providerId = `u-${teamA.slice(0, 8)}`;
const priced = `${teamA.slice(0, 8)}-priced`;
const sandboxId = randomUUID();

beforeAll(async () => {
  const owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values([
    { id: teamA, slug: `ua-${teamA.slice(0, 8)}`, name: "Usage A" },
    { id: teamB, slug: `ub-${teamB.slice(0, 8)}`, name: "Usage B" },
  ]);
  await owner.close();
  app = createDb(inject("appUrl"));
  await app.db.insert(users).values({ id: userId, name: "U", email: `${userId}@u.test` });
  await withTeam(app.db, teamA, (tx) =>
    tx.insert(teamMembers).values({ teamId: teamA, userId, role: "member" }),
  );
  await app.db.insert(modelProviders).values({
    id: providerId,
    kind: "openai_compatible",
    name: "Usage test",
    baseUrl: "http://usage.invalid",
    createdBy: userId,
  });
  await app.db.insert(modelCatalog).values([
    {
      alias: `${priced}-a`,
      providerId,
      model: "priced",
      inputUsdPerMtok: 3,
      outputUsdPerMtok: 15,
      cacheReadUsdPerMtok: 0.3,
      createdBy: userId,
    },
    // A second alias for the same model with a higher output price: the higher price counts.
    {
      alias: `${priced}-b`,
      providerId,
      model: "priced",
      inputUsdPerMtok: 3,
      outputUsdPerMtok: 20,
      createdBy: userId,
    },
    { alias: `${priced}-free`, providerId, model: "unpriced", createdBy: userId },
  ]);
});
afterAll(() => app.close());

const record = (over: Partial<ModelUsageRecord> = {}): ModelUsageRecord => ({
  id: randomUUID(),
  teamId: teamA,
  userId,
  sandboxId,
  runId: undefined,
  at: new Date(),
  route: "openai",
  model: `kobe-${providerId}/priced`,
  status: 200,
  inputTokens: 1_000,
  outputTokens: 2_000,
  cacheReadTokens: 10_000,
  cacheWriteTokens: 0,
  usageSource: "reported",
  durationMs: 1234,
  ttfbMs: 100,
  aborted: false,
  ...over,
});

describe("recordModelUsage", () => {
  it("prices a call at the catalog's highest price per kind; cache reads at their own price", async () => {
    await recordModelUsage(app.db, [record({ sandboxId: randomUUID() })]);
    const rows = await withTeam(app.db, teamA, (tx) =>
      tx.select().from(runUsage).where(eq(runUsage.teamId, teamA)),
    );
    const row = rows.at(-1);
    // 1000 × 3 + 2000 × 20 + 10000 × 0.3 = 46000 µ$ = $0.046
    expect(row?.costUsd).toBeCloseTo(0.046, 9);
    expect(row).toMatchObject({ inputTokens: 1000, outputTokens: 2000, usageSource: "reported" });
  });

  it("leaves the cost empty for a model without prices but keeps the tokens", async () => {
    const sb = randomUUID();
    await recordModelUsage(app.db, [
      record({ sandboxId: sb, model: `kobe-${providerId}/unpriced` }),
    ]);
    const [row] = await withTeam(app.db, teamA, (tx) =>
      tx.select().from(runUsage).where(eq(runUsage.sandboxId, sb)),
    );
    expect(row?.costUsd).toBeNull();
    expect(row?.outputTokens).toBe(2000);
  });

  it("attributes the run's thread and agent, and keeps the row when the run is gone", async () => {
    const { runId, threadId } = await withTeam(app.db, teamA, async (tx) => {
      const [thread] = await tx
        .insert(threads)
        .values({ teamId: teamA, ownerUserId: userId })
        .returning({ id: threads.id });
      if (!thread) throw new Error("no thread");
      const [run] = await tx
        .insert(runs)
        .values({ teamId: teamA, threadId: thread.id, trigger: "user", status: "queued" })
        .returning({ id: runs.id });
      if (!run) throw new Error("no run");
      return { runId: run.id, threadId: thread.id };
    });
    const sb = randomUUID();
    await recordModelUsage(app.db, [record({ sandboxId: sb, runId })]);
    // The thread is purged (D18): the ledger keeps the spend.
    await withTeam(app.db, teamA, (tx) => tx.delete(threads).where(eq(threads.id, threadId)));
    const [row] = await withTeam(app.db, teamA, (tx) =>
      tx.select().from(runUsage).where(eq(runUsage.sandboxId, sb)),
    );
    expect(row).toMatchObject({ runId, threadId, agentId: null });
  });

  it("is idempotent per record id: flushing the same record twice writes one row", async () => {
    const sb = randomUUID();
    const rec = record({ sandboxId: sb });
    const first = await recordModelUsage(app.db, [rec]);
    const second = await recordModelUsage(app.db, [rec]);
    expect([first, second]).toEqual([1, 0]);
    const rows = await withTeam(app.db, teamA, (tx) =>
      tx.select().from(runUsage).where(eq(runUsage.sandboxId, sb)),
    );
    expect(rows).toHaveLength(1);
  });

  it("writes each team's rows under its own RLS context; another team never sees them", async () => {
    const sbA = randomUUID();
    const sbB = randomUUID();
    const written = await recordModelUsage(app.db, [
      record({ sandboxId: sbA }),
      record({ teamId: teamB, sandboxId: sbB }),
    ]);
    expect(written).toBe(2);
    const seenByB = await withTeam(app.db, teamB, (tx) =>
      tx.select({ sandboxId: runUsage.sandboxId }).from(runUsage),
    );
    expect(seenByB.map((r) => r.sandboxId)).toEqual([sbB]);
  });

  it("is append-only for the app role: rows cannot be changed or removed (KOBE-43 review)", async () => {
    const sb = randomUUID();
    await recordModelUsage(app.db, [record({ sandboxId: sb })]);
    const update = await withTeam(app.db, teamA, (tx) =>
      tx.update(runUsage).set({ inputTokens: 0 }).where(eq(runUsage.sandboxId, sb)),
    ).catch((e: unknown) => e);
    expect((update as { cause?: { code?: string } }).cause?.code).toBe("42501");
    const del = await withTeam(app.db, teamA, (tx) =>
      tx.delete(runUsage).where(eq(runUsage.sandboxId, sb)),
    ).catch((e: unknown) => e);
    expect((del as { cause?: { code?: string } }).cause?.code).toBe("42501");
  });

  it("clamps absurd counts instead of failing the batch", async () => {
    const sb = randomUUID();
    await recordModelUsage(app.db, [
      record({ sandboxId: sb, inputTokens: 1e12, outputTokens: -5, durationMs: -1 }),
    ]);
    const [row] = await withTeam(app.db, teamA, (tx) =>
      tx.select().from(runUsage).where(eq(runUsage.sandboxId, sb)),
    );
    expect(row).toMatchObject({ inputTokens: 2_000_000_000, outputTokens: 0, durationMs: 0 });
  });
});
