import { eq, modelCatalog, modelProviders, teamModels, withTeam } from "@kobe/db";
import type { KobeDb, ModelProviderKind } from "@kobe/db";

/**
 * The provider model id an Orbit export carries (KOBE-91): Kobe's catalog aliases mean nothing to
 * Orbit/Inspect, so the pinned alias (or the team default) is resolved against the team's enabled
 * models. Unresolvable is an error for the caller (409), never a silent drop.
 */
export interface OrbitModelOption {
  readonly alias: string;
  readonly isDefault: boolean;
  readonly kind: ModelProviderKind;
  readonly providerId: string;
  readonly model: string;
}

/** Inspect's names: `<provider>/<model>`; OpenAI-compatible endpoints go through `openai-api`. */
export function orbitModelId(o: OrbitModelOption): string {
  return o.kind === "openai_compatible"
    ? `openai-api/${o.providerId}/${o.model}`
    : `${o.kind}/${o.model}`;
}

export type OrbitModelResult =
  | { readonly ok: true; readonly model: string }
  | { readonly ok: false; readonly code: "model_not_resolvable"; readonly message: string };

export function resolveOrbitModel(
  pinned: string | undefined,
  options: readonly OrbitModelOption[],
): OrbitModelResult {
  const chosen =
    pinned === undefined
      ? options.find((o) => o.isDefault)
      : options.find((o) => o.alias === pinned);
  if (chosen) return { ok: true, model: orbitModelId(chosen) };
  return {
    ok: false,
    code: "model_not_resolvable",
    message:
      pinned === undefined
        ? "This agent pins no model and the team has no default model, so Orbit can't be told which to use."
        : `This agent pins the model "${pinned}", which is not enabled for the team, so it can't be exported.`,
  };
}

/** The team's enabled models with their provider details (enablement is under RLS). */
export function listOrbitModelOptions(db: KobeDb, teamId: string): Promise<OrbitModelOption[]> {
  return withTeam(db, teamId, (tx) =>
    tx
      .select({
        alias: teamModels.alias,
        isDefault: teamModels.isDefault,
        kind: modelProviders.kind,
        providerId: modelProviders.id,
        model: modelCatalog.model,
      })
      .from(teamModels)
      .innerJoin(modelCatalog, eq(modelCatalog.alias, teamModels.alias))
      .innerJoin(modelProviders, eq(modelProviders.id, modelCatalog.providerId))
      .where(eq(teamModels.teamId, teamId)),
  );
}
