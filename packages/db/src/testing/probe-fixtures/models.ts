import { randomUUID } from "node:crypto";
import {
  modelCatalog,
  modelGatewayKeys,
  modelProviders,
  runTokens,
  runUsage,
  runs,
  teamBudgets,
  teamModels,
  threads,
  users,
} from "../../schema/index.js";
import type { models } from "../../tenancy/models.js";
import type { ProbeFixture } from "./types.js";

export const modelsFixtures: Record<(typeof models.team)[number], ProbeFixture> = {
  team_models: async (tx, teamId) => {
    const userId = randomUUID();
    const providerId = `probe-${teamId.slice(0, 8)}`;
    const alias = `probe-${teamId.slice(0, 8)}`;
    await tx.insert(users).values({ id: userId, name: "Probe", email: `${userId}@probe.test` });
    await tx
      .insert(modelProviders)
      .values({
        id: providerId,
        kind: "openai_compatible",
        name: "Probe",
        baseUrl: "http://probe.invalid",
        createdBy: userId,
      })
      .onConflictDoNothing();
    await tx
      .insert(modelCatalog)
      .values({ alias, providerId, model: "probe-model", createdBy: userId })
      .onConflictDoNothing();
    await tx.insert(teamModels).values({ teamId, alias, isDefault: true, enabledBy: userId });
  },
  model_gateway_keys: async (tx, teamId) => {
    const userId = randomUUID();
    await tx.insert(users).values({ id: userId, name: "Probe", email: `${userId}@probe.test` });
    await tx
      .insert(modelGatewayKeys)
      .values({ teamId, userId, vkId: randomUUID(), vkValueEnc: "v1.probe" });
  },
  run_usage: async (tx, teamId) => {
    const userId = randomUUID();
    await tx.insert(users).values({ id: userId, name: "Probe", email: `${userId}@probe.test` });
    await tx.insert(runUsage).values({
      teamId,
      userId,
      sandboxId: randomUUID(),
      route: "openai",
      model: "probe/probe-model",
      status: 200,
      inputTokens: 5,
      outputTokens: 3,
      usageSource: "reported",
      durationMs: 10,
    });
  },
  team_budgets: async (tx, teamId) => {
    const userId = randomUUID();
    await tx.insert(users).values({ id: userId, name: "Probe", email: `${userId}@probe.test` });
    await tx.insert(teamBudgets).values({ teamId, monthlyUsd: 100, updatedBy: userId });
  },
  run_tokens: async (tx, teamId) => {
    const userId = randomUUID();
    await tx.insert(users).values({ id: userId, name: "Probe", email: `${userId}@probe.test` });
    const [thread] = await tx
      .insert(threads)
      .values({ teamId, ownerUserId: userId })
      .returning({ id: threads.id });
    if (!thread) throw new Error("probe: thread insert returned nothing");
    const [run] = await tx
      .insert(runs)
      .values({
        teamId,
        threadId: thread.id,
        trigger: "user",
        status: "running",
        startedAt: new Date(),
      })
      .returning({ id: runs.id });
    if (!run) throw new Error("probe: run insert returned nothing");
    await tx.insert(runTokens).values({
      teamId,
      jti: randomUUID(),
      runId: run.id,
      sandboxId: randomUUID(),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  },
  // Kept by the run_usage trigger only (guarded): a usage row makes the counter row.
  model_spend_daily: async (tx, teamId) => {
    const userId = randomUUID();
    await tx.insert(users).values({ id: userId, name: "Probe", email: `${userId}@probe.test` });
    await tx.insert(runUsage).values({
      teamId,
      userId,
      sandboxId: randomUUID(),
      route: "openai",
      model: "probe/probe-model",
      status: 200,
      inputTokens: 1,
      usageSource: "reported",
      durationMs: 1,
    });
  },
};
