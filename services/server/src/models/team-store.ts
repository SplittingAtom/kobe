import {
  and,
  asc,
  bumpModelsConfig,
  eq,
  modelCatalog,
  modelProviders,
  teamModels,
  withTeam,
  type KobeDb,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { catalogView, type CatalogView } from "./admin-store.js";
import type { TeamModelInput } from "./schemas.js";

/**
 * Team model enablement (spec D6, D30; `/v1/team/models`): team admins choose a subset of the
 * install catalog and one default. The gateway allows a team's members exactly the enabled models.
 */
export interface TeamModelView extends CatalogView {
  readonly enabled: boolean;
  readonly is_default: boolean;
}

/** The whole catalog with the team's choice (catalog install-wide; enablement under RLS). */
export async function listTeamModels(db: KobeDb, teamId: string): Promise<TeamModelView[]> {
  const [catalog, enabled] = await Promise.all([
    db
      .select({ entry: modelCatalog, kind: modelProviders.kind })
      .from(modelCatalog)
      .innerJoin(modelProviders, eq(modelProviders.id, modelCatalog.providerId))
      .orderBy(asc(modelCatalog.alias)),
    withTeam(db, teamId, (tx) => tx.select().from(teamModels).where(eq(teamModels.teamId, teamId))),
  ]);
  const byAlias = new Map(enabled.map((r) => [r.alias, r]));
  return catalog.map((c) => {
    const e = byAlias.get(c.entry.alias);
    return {
      ...catalogView(c.entry, c.kind),
      enabled: e !== undefined,
      is_default: e?.isDefault ?? false,
    };
  });
}

export type SetTeamModelResult =
  "changed" | "unchanged" | "not_in_catalog" | "default_requires_enabled";

/** Enables/disables an alias for the team and optionally makes it the team's default. */
export async function setTeamModel(
  db: KobeDb,
  teamId: string,
  alias: string,
  input: TeamModelInput,
  userId: string,
): Promise<SetTeamModelResult> {
  if (input.is_default && !input.enabled) return "default_requires_enabled";
  return withTeam(db, teamId, async (tx) => {
    // FOR SHARE: the catalog entry can't be removed until this commits.
    const [entry] = await tx
      .select({ alias: modelCatalog.alias })
      .from(modelCatalog)
      .where(eq(modelCatalog.alias, alias))
      .for("share");
    if (!entry) return "not_in_catalog";
    const [before] = await tx
      .select()
      .from(teamModels)
      .where(and(eq(teamModels.teamId, teamId), eq(teamModels.alias, alias)))
      .for("update");
    const wantDefault = input.enabled && (input.is_default ?? before?.isDefault ?? false);
    if (!input.enabled) {
      if (!before) return "unchanged";
      await tx
        .delete(teamModels)
        .where(and(eq(teamModels.teamId, teamId), eq(teamModels.alias, alias)));
    } else {
      if (before && before.isDefault === wantDefault) return "unchanged";
      if (wantDefault) {
        await tx
          .update(teamModels)
          .set({ isDefault: false })
          .where(and(eq(teamModels.teamId, teamId), eq(teamModels.isDefault, true)));
      }
      await tx
        .insert(teamModels)
        .values({ teamId, alias, isDefault: wantDefault, enabledBy: userId })
        .onConflictDoUpdate({
          target: [teamModels.teamId, teamModels.alias],
          set: { isDefault: wantDefault },
        });
    }
    await bumpModelsConfig(tx);
    await recordAudit(tx, {
      action: "models.team.changed",
      teamId,
      target: { alias, enabled: input.enabled, isDefault: wantDefault },
    });
    return "changed";
  });
}
