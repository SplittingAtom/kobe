import type { PiModelApi, PiThreadConfig } from "@kobe/protocol";
import {
  and,
  eq,
  gatewayProviderName,
  modelCatalog,
  modelProviders,
  teamModels,
  type KobeTx,
  type ModelProviderKind,
} from "@kobe/db";

/**
 * The model of a run (spec D30; KOBE-41), resolved on the server because the sandbox has no user
 * session: the requested alias (the thread's or agent's, from the agent resolver) when the team
 * enabled it, else the team's default. Each comes with the gateway's model id (`<gateway
 * provider>/<model>`, what Bifrost and the shim allow by) and the API style Pi must speak to it.
 * Undefined when the team has nothing usable: the run then fails `model_not_configured` in the
 * sandbox agent (no model to offer Pi), and nothing is woken for it on the server side.
 */
export type RunModelConfig = NonNullable<PiThreadConfig["model"]> & {
  readonly gateway_model: string;
  readonly api: PiModelApi;
};

/** Which of Pi's API adapters a provider kind needs through the gateway (KOBE-40 base paths). */
export function apiForKind(kind: ModelProviderKind): PiModelApi {
  switch (kind) {
    case "anthropic":
      return "anthropic-messages";
    case "gemini":
      return "google-generative-ai";
    case "openai":
    case "ollama":
    case "openai_compatible":
      return "openai-completions";
  }
}

interface EnabledModel {
  readonly alias: string;
  readonly isDefault: boolean;
  readonly gatewayModel: string;
  readonly api: PiModelApi;
}

/** The team's enabled models (RLS: inside `withTeam`). */
async function enabledModels(tx: KobeTx, teamId: string): Promise<EnabledModel[]> {
  const rows = await tx
    .select({
      alias: teamModels.alias,
      isDefault: teamModels.isDefault,
      providerId: modelCatalog.providerId,
      model: modelCatalog.model,
      kind: modelProviders.kind,
    })
    .from(teamModels)
    .innerJoin(modelCatalog, eq(modelCatalog.alias, teamModels.alias))
    .innerJoin(modelProviders, eq(modelProviders.id, modelCatalog.providerId))
    .where(and(eq(teamModels.teamId, teamId)));
  return rows.map((r) => ({
    alias: r.alias,
    isDefault: r.isDefault,
    gatewayModel: `${gatewayProviderName(r.providerId, r.kind)}/${r.model}`,
    api: apiForKind(r.kind),
  }));
}

export async function resolveRunModel(
  tx: KobeTx,
  teamId: string,
  requestedAlias: string | undefined,
): Promise<RunModelConfig | undefined> {
  const enabled = await enabledModels(tx, teamId);
  const chosen =
    (requestedAlias === undefined ? undefined : enabled.find((m) => m.alias === requestedAlias)) ??
    enabled.find((m) => m.isDefault);
  return chosen === undefined
    ? undefined
    : { alias: chosen.alias, gateway_model: chosen.gatewayModel, api: chosen.api };
}
