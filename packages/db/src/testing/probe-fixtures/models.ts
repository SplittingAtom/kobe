import { randomUUID } from "node:crypto";
import {
  modelCatalog,
  modelGatewayKeys,
  modelProviders,
  modelSpendDaily,
  runUsage,
  teamBudgets,
  teamModels,
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
  model_spend_daily: async (tx, teamId) => {
    await tx
      .insert(modelSpendDaily)
      .values({ teamId, day: "2026-10-01", userId: randomUUID(), costUsd: 1, calls: 1 });
  },
};
