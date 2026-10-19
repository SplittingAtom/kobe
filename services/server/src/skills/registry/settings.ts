import {
  REGISTRY_SETTING_NAMES,
  registryImportAllowlistSchema,
  registryMirrorSchema,
  registryScannerSchema,
  registrySubmissionRulesSchema,
  skillEvalLimitsSchema,
  type RegistrySettingName,
  type RegistrySettings,
  type RegistrySettingsUpdate,
} from "@kobe/protocol";
import { eq, modelCatalog, siteSkillSettings, teams, type KobeDb, type KobeTx } from "@kobe/db";
import { recordAudit } from "../../audit/record.js";

/**
 * Registry settings (KOBE-330, SK20, SK21): the one `site_skill_settings` row, read with every
 * document's defaults filled in (a stored document that no longer parses reads as the defaults,
 * so a bad row never blocks the Registry), and written by Site admins with validation (the
 * Registry team must exist, the judge alias must be a catalog model) and one audit event.
 */

function parsed<T>(
  schema: { safeParse(v: unknown): { success: boolean; data?: T } },
  v: unknown,
  fallback: T,
): T {
  const r = schema.safeParse(v);
  return r.success ? (r.data as T) : fallback;
}

async function readRow(db: KobeDb | KobeTx) {
  const [row] = await db
    .select({
      registryTeamId: siteSkillSettings.registryTeamId,
      teamSlug: teams.slug,
      teamName: teams.name,
      judgeAlias: siteSkillSettings.judgeAlias,
      submissionRules: siteSkillSettings.submissionRules,
      evalLimits: siteSkillSettings.evalLimits,
      importAllowlist: siteSkillSettings.importAllowlist,
      scanner: siteSkillSettings.scanner,
      mirror: siteSkillSettings.mirror,
      updatedAt: siteSkillSettings.updatedAt,
    })
    .from(siteSkillSettings)
    .leftJoin(teams, eq(teams.id, siteSkillSettings.registryTeamId))
    .where(eq(siteSkillSettings.id, 1));
  return row;
}

export async function readRegistrySettings(db: KobeDb | KobeTx): Promise<RegistrySettings> {
  const row = await readRow(db);
  const team =
    row?.registryTeamId && row.teamSlug && row.teamName
      ? { id: row.registryTeamId, slug: row.teamSlug, name: row.teamName }
      : null;
  return {
    ready: team !== null,
    registryTeam: team,
    judgeAlias: row?.judgeAlias ?? null,
    submissionRules: parsed(
      registrySubmissionRulesSchema,
      row?.submissionRules ?? {},
      registrySubmissionRulesSchema.parse({}),
    ),
    evalLimits: parsed(
      skillEvalLimitsSchema,
      row?.evalLimits ?? {},
      skillEvalLimitsSchema.parse({}),
    ),
    importAllowlist: parsed(registryImportAllowlistSchema, row?.importAllowlist ?? [], []),
    scanner: parsed(registryScannerSchema, row?.scanner ?? {}, registryScannerSchema.parse({})),
    mirror: parsed(registryMirrorSchema, row?.mirror ?? {}, registryMirrorSchema.parse({})),
    updatedAt: (row?.updatedAt ?? new Date(0)).toISOString(),
  };
}

/**
 * Whether the Registry can approve (SK21): a Registry team is named. Approve (and the review
 * re-runs that need the team) must refuse while this is false.
 */
export async function registryReady(db: KobeDb | KobeTx): Promise<boolean> {
  return (await readRow(db))?.registryTeamId != null;
}

export type RegistryUpdateResult =
  | { readonly ok: true; readonly settings: RegistrySettings }
  | {
      readonly ok: false;
      readonly code: "unknown_team" | "unknown_alias";
      readonly message: string;
    };

export async function updateRegistrySettings(
  db: KobeDb,
  update: RegistrySettingsUpdate,
  userId: string,
): Promise<RegistryUpdateResult> {
  return db.transaction(async (tx) => {
    if (update.registryTeamId) {
      const [team] = await tx
        .select({ id: teams.id })
        .from(teams)
        .where(eq(teams.id, update.registryTeamId));
      if (!team) return { ok: false, code: "unknown_team", message: "No team with that id." };
    }
    if (update.judgeAlias) {
      const [model] = await tx
        .select({ alias: modelCatalog.alias })
        .from(modelCatalog)
        .where(eq(modelCatalog.alias, update.judgeAlias));
      if (!model)
        return {
          ok: false,
          code: "unknown_alias",
          message: "No model in the catalog has that alias.",
        };
    }
    const changed: RegistrySettingName[] = REGISTRY_SETTING_NAMES.filter(
      (k) => update[k] !== undefined,
    );
    await tx
      .update(siteSkillSettings)
      .set({
        ...(update.registryTeamId !== undefined ? { registryTeamId: update.registryTeamId } : {}),
        ...(update.judgeAlias !== undefined ? { judgeAlias: update.judgeAlias } : {}),
        ...(update.submissionRules ? { submissionRules: update.submissionRules } : {}),
        ...(update.evalLimits ? { evalLimits: update.evalLimits } : {}),
        ...(update.importAllowlist ? { importAllowlist: update.importAllowlist } : {}),
        ...(update.scanner ? { scanner: update.scanner } : {}),
        ...(update.mirror ? { mirror: update.mirror } : {}),
        updatedBy: userId,
        updatedAt: new Date(),
      })
      .where(eq(siteSkillSettings.id, 1));
    await recordAudit(tx, {
      action: "skill.registry.settings_updated",
      target: {
        changed,
        ...(update.registryTeamId !== undefined ? { registryTeamId: update.registryTeamId } : {}),
        ...(update.judgeAlias !== undefined ? { judgeAlias: update.judgeAlias } : {}),
      },
    });
    return { ok: true, settings: await readRegistrySettings(tx) };
  });
}
