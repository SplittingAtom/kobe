import {
  narrowThinkingPolicy,
  strictestThinkingPolicy,
  type PiModelApi,
  type PiThreadConfig,
  type ThinkingLevel,
  type ThinkingPolicy,
} from "@kobe/protocol";
import { catalogThinking } from "../models/thinking.js";
import type { CatalogTokenLimits } from "../models/token-limits.js";
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
  readonly limits: CatalogTokenLimits;
  readonly thinking: RunModelThinking;
}

/** The model's thinking settings for the team (KOBE-260): the site's and the team's maximum. */
export interface RunModelThinking {
  readonly site: ThinkingPolicy;
  readonly teamMax: ThinkingLevel | null;
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
      maxOutputTokens: modelCatalog.maxOutputTokens,
      contextWindow: modelCatalog.contextWindow,
      reasoning: modelCatalog.reasoning,
      thinkingControl: modelCatalog.thinkingControl,
      thinkingAllowed: modelCatalog.thinkingAllowed,
      thinkingDefault: modelCatalog.thinkingDefault,
      thinkingMax: modelCatalog.thinkingMax,
      thinkingLowest: modelCatalog.thinkingLowest,
      teamThinkingMax: teamModels.thinkingMax,
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
    limits: {
      maxOutputTokens: r.maxOutputTokens,
      contextWindow: r.contextWindow,
      reasoning: r.reasoning,
    },
    thinking: { site: catalogThinking(r), teamMax: r.teamThinkingMax },
  }));
}

/**
 * `limits`: what the catalog says about the model's output limit and context window (KOBE-259);
 * the dispatcher adds the site defaults when it sends `run.start`.
 */
export type RunModelResolution =
  | {
      readonly ok: true;
      readonly model: RunModelConfig | undefined;
      readonly limits?: CatalogTokenLimits;
      /** The model's thinking settings for the team (KOBE-260); absent without a model. */
      readonly thinking?: RunModelThinking;
    }
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
  if (chosen === undefined) return { ok: true, model: undefined };
  // Several aliases may name one provider model: the gateway writes the strictest of their
  // policies, so the run records that one too (review N1).
  const strictest = strictestThinkingPolicy(
    enabled
      .filter((m) => m.gatewayModel === chosen.gatewayModel)
      .map((m) => narrowThinkingPolicy(m.thinking.site, m.thinking.teamMax)),
  );
  const thinking = strictest === undefined ? chosen.thinking : { site: strictest, teamMax: null };
  return {
    ok: true,
    model: { alias: chosen.alias, gateway_model: chosen.gatewayModel, api: chosen.api },
    limits: chosen.limits,
    thinking,
  };
}

/**
 * Whether the catalog says a model accepts image input (KOBE-191). The catalog is site-wide,
 * so no team context is needed; an alias that is not in it (or none) accepts text only.
 */
/**
 * The gateway model a catalog alias names (`<gateway provider>/<model>`), as `run.start` passes
 * it and Pi records it (`model_change.modelId` under the `kobe` provider); undefined if unknown.
 */
export async function gatewayModelOf(
  tx: KobeTx,
  alias: string | undefined,
): Promise<string | undefined> {
  if (alias === undefined) return undefined;
  const [row] = await tx
    .select({
      providerId: modelCatalog.providerId,
      model: modelCatalog.model,
      kind: modelProviders.kind,
    })
    .from(modelCatalog)
    .innerJoin(modelProviders, eq(modelProviders.id, modelCatalog.providerId))
    .where(eq(modelCatalog.alias, alias));
  return row === undefined
    ? undefined
    : `${gatewayProviderName(row.providerId, row.kind)}/${row.model}`;
}

export async function modelAcceptsImages(tx: KobeTx, alias: string | undefined): Promise<boolean> {
  if (alias === undefined) return false;
  const [row] = await tx
    .select({ modalities: modelCatalog.inputModalities })
    .from(modelCatalog)
    .where(eq(modelCatalog.alias, alias));
  return row?.modalities.includes("image") ?? false;
}
