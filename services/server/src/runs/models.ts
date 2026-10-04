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
 * session. A requested alias (the agent's pin, from the agent resolver) must be enabled for the
 * team, else the run fails `agent_model_not_enabled` (user decision: never fall back silently);
 * only a run with no requested alias uses the team's default. Each comes with the gateway's model
 * id (`<gateway provider>/<model>`, what Bifrost and the shim allow by) and the API style Pi must
 * speak to it. `model: undefined` when the team has nothing usable: the run then fails
 * `model_not_configured` in the sandbox agent (no model to offer Pi).
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

export type RunModelResolution =
  | { readonly ok: true; readonly model: RunModelConfig | undefined }
  | { readonly ok: false; readonly code: "agent_model_not_enabled"; readonly alias: string };

export async function resolveRunModel(
  tx: KobeTx,
  teamId: string,
  requestedAlias: string | undefined,
): Promise<RunModelResolution> {
  const enabled = await enabledModels(tx, teamId);
  const chosen =
    requestedAlias === undefined
      ? enabled.find((m) => m.isDefault)
      : enabled.find((m) => m.alias === requestedAlias);
  if (requestedAlias !== undefined && chosen === undefined) {
    return { ok: false, code: "agent_model_not_enabled", alias: requestedAlias };
  }
  return {
    ok: true,
    model:
      chosen === undefined
        ? undefined
        : { alias: chosen.alias, gateway_model: chosen.gatewayModel, api: chosen.api },
  };
}
