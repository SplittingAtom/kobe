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
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import type { ThinkingLevel } from "@kobe/protocol";
import { catalogView, type CatalogView } from "./admin-store.js";
import {
  catalogThinking,
  chatThinking,
  checkTeamThinking,
  type ChatThinkingView,
} from "./thinking.js";
import type { TeamModelInput } from "./schemas.js";

/**
 * Team model enablement (spec D6, D30; `/v1/team/models`): team admins choose a subset of the
 * site catalog and one default. The gateway allows a team's members exactly the enabled models.
 */
export interface TeamModelView extends CatalogView {
  readonly enabled: boolean;
  readonly is_default: boolean;
  /** The team's thinking maximum for the model (KOBE-260); null: the site's. */
  readonly thinking_max: ThinkingLevel | null;
  /** What members get for the model in this team: the default level and the levels to pick. */
  readonly thinking_in_team: ChatThinkingView;
}

/** The whole catalog with the team's choice (catalog site-wide; enablement under RLS). */
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
    const teamMax = e?.thinkingMax ?? null;
    return {
      ...catalogView(c.entry, c.kind),
      enabled: e !== undefined,
      is_default: e?.isDefault ?? false,
      thinking_max: teamMax,
      thinking_in_team: chatThinking(catalogThinking(c.entry), teamMax),
    };
  });
}

export type SetTeamModelResult =
  | "changed"
  | "unchanged"
  | "not_in_catalog"
  | "default_requires_enabled"
  | { readonly error: "thinking_invalid"; readonly message: string };

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
      .select()
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
    // KOBE-260 ac-4: a team maximum may only narrow the site's settings.
    const thinkingMax = input.enabled ? keepMax(input.thinking_max, before?.thinkingMax) : null;
    if (input.thinking_max !== undefined && input.thinking_max !== null) {
      const message = checkTeamThinking(catalogThinking(entry), input.thinking_max);
      if (message !== undefined) return { error: "thinking_invalid", message };
    }
    if (!input.enabled) {
      if (!before) return "unchanged";
      await tx
        .delete(teamModels)
        .where(and(eq(teamModels.teamId, teamId), eq(teamModels.alias, alias)));
    } else {
      if (before && before.isDefault === wantDefault && before.thinkingMax === thinkingMax) {
        return "unchanged";
      }
      if (wantDefault) {
        await tx
          .update(teamModels)
          .set({ isDefault: false })
          .where(and(eq(teamModels.teamId, teamId), eq(teamModels.isDefault, true)));
      }
      await tx
        .insert(teamModels)
        .values({ teamId, alias, isDefault: wantDefault, thinkingMax, enabledBy: userId })
        .onConflictDoUpdate({
          target: [teamModels.teamId, teamModels.alias],
          set: { isDefault: wantDefault, thinkingMax },
        });
    }
    await bumpModelsConfig(tx);
    await recordAudit(tx, {
      action: "models.team.changed",
      teamId,
      target: { alias, enabled: input.enabled, isDefault: wantDefault, thinkingMax },
    });
    return "changed";
  });
}

/** An optional team maximum: undefined keeps the stored one, null clears it. */
const keepMax = (
  next: ThinkingLevel | null | undefined,
  before: ThinkingLevel | null | undefined,
): ThinkingLevel | null => (next === undefined ? (before ?? null) : next);

/**
 * Whether the team enabled `alias` now (inside the caller's `withTeam` transaction, RLS). A
 * thread's model choice (KOBE-44) must be one of these when it is made.
 */
export async function isModelEnabled(tx: KobeTx, teamId: string, alias: string): Promise<boolean> {
  const [row] = await tx
    .select({ alias: teamModels.alias })
    .from(teamModels)
    .where(and(eq(teamModels.teamId, teamId), eq(teamModels.alias, alias)));
  return row !== undefined;
}
