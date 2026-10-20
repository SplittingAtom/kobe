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
  type RegistryTeamCreate,
} from "@kobe/protocol";
import {
  eq,
  modelCatalog,
  siteSkillSettings,
  sql,
  teams,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../../audit/record.js";
import { logger } from "../../logger.js";
import { createTeamWithAdmin } from "../../teams/members.js";
import { joinRegistryTeamInTx, reviewerIds } from "./grants.js";

/**
 * Registry settings (KOBE-330, SK20, SK21): the one `site_skill_settings` row, read with every
 * document's defaults filled in, and written by Site admins with validation and one audit event
 * naming the settings whose values changed. The Registry team is not a setting: it is always a
 * dedicated team Kobe creates (`teams.registry`, coordinator decision, review H1), so the Skill
 * reviewer grant can never add anyone to an ordinary team; the database refuses naming any other.
 */

type Db = KobeDb | KobeTx;

/** A stored document that no longer parses reads as its defaults, and says so (review L3). */
function parsed<T>(
  name: string,
  schema: { safeParse(v: unknown): { success: boolean; data?: T } },
  v: unknown,
  fallback: T,
): T {
  const r = schema.safeParse(v);
  if (r.success) return r.data as T;
  logger.warn(
    { setting: name },
    "registry settings: a stored document doesn't parse; using defaults",
  );
  return fallback;
}

async function readRow(db: Db) {
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

export async function readRegistrySettings(db: Db): Promise<RegistrySettings> {
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
      "submissionRules",
      registrySubmissionRulesSchema,
      row?.submissionRules ?? {},
      registrySubmissionRulesSchema.parse({}),
    ),
    evalLimits: parsed(
      "evalLimits",
      skillEvalLimitsSchema,
      row?.evalLimits ?? {},
      skillEvalLimitsSchema.parse({}),
    ),
    importAllowlist: parsed(
      "importAllowlist",
      registryImportAllowlistSchema,
      row?.importAllowlist ?? [],
      [],
    ),
    scanner: parsed("scanner", registryScannerSchema, row?.scanner ?? {}, {
      external: false,
    }),
    mirror: parsed("mirror", registryMirrorSchema, row?.mirror ?? {}, { enabled: false }),
    updatedAt: (row?.updatedAt ?? new Date(0)).toISOString(),
  };
}

/**
 * The Registry team, read with a share lock on the settings row (review M2): call it inside the
 * transaction of anything that needs the Registry (Approve, re-runs; KOBE-333 onward) and use the
 * id it returns, so a concurrent change can't leave the action without a team.
 */
export async function registryTeamFor(tx: Db): Promise<string | null> {
  const res = await tx.execute<{ id: string | null }>(sql`
    SELECT registry_team_id AS id FROM site_skill_settings WHERE id = 1 FOR SHARE`);
  return res.rows[0]?.id ?? null;
}

/** The guard for Registry actions: the team, or `registry_not_ready` (answer 409). */
export async function requireRegistryTeam(
  tx: Db,
): Promise<
  | { readonly ok: true; readonly teamId: string }
  | { readonly ok: false; readonly code: "registry_not_ready" }
> {
  const teamId = await registryTeamFor(tx);
  return teamId ? { ok: true, teamId } : { ok: false, code: "registry_not_ready" };
}

/** Whether the Registry can approve (SK21): its team exists. */
export async function registryReady(db: Db): Promise<boolean> {
  return (await registryTeamFor(db)) !== null;
}

export type RegistryUpdateResult =
  | { readonly ok: true; readonly settings: RegistrySettings }
  | { readonly ok: false; readonly code: "unknown_alias"; readonly message: string };

/** JSON with sorted keys, to tell a changed document from a re-sent one (review L2). */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v !== null && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v ?? null);
}

export async function updateRegistrySettings(
  db: KobeDb,
  update: RegistrySettingsUpdate,
  userId: string,
): Promise<RegistryUpdateResult> {
  return db.transaction(async (tx) => {
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
    const before = await readRegistrySettings(tx);
    const changed = REGISTRY_SETTING_NAMES.filter(
      (k): k is Exclude<RegistrySettingName, "registryTeamId"> =>
        k !== "registryTeamId" &&
        update[k] !== undefined &&
        stable(update[k]) !== stable(before[k]),
    );
    if (changed.length === 0) return { ok: true, settings: before };
    const set = Object.fromEntries(changed.map((k) => [k, update[k]]));
    await tx
      .update(siteSkillSettings)
      .set({ ...set, updatedBy: userId, updatedAt: new Date() })
      .where(eq(siteSkillSettings.id, 1));
    await recordAudit(tx, {
      action: "skill.registry.settings_updated",
      target: {
        changed,
        ...(changed.includes("judgeAlias") ? { judgeAlias: update.judgeAlias ?? null } : {}),
      },
    });
    return { ok: true, settings: await readRegistrySettings(tx) };
  });
}

export type RegistryTeamResult =
  | { readonly ok: true; readonly settings: RegistrySettings }
  | {
      readonly ok: false;
      readonly code: "registry_exists" | "slug_taken";
      readonly message: string;
    };

function pgCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  const code = e.cause?.code ?? e.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Creates the dedicated Registry team (review H1): flagged `registry`, the creating Site admin its
 * team admin (they review anyway, SK21), every active Skill reviewer a member (`added_via` the
 * grant), and names it, all in one transaction. A Site has at most one; while it exists another
 * is refused.
 */
export async function createRegistryTeam(
  db: KobeDb,
  input: RegistryTeamCreate,
  adminId: string,
): Promise<RegistryTeamResult> {
  if ((await registryTeamFor(db)) !== null)
    return { ok: false, code: "registry_exists", message: "The Registry team already exists." };
  try {
    await createTeamWithAdmin(
      db,
      { slug: input.slug, name: input.name, registry: true },
      adminId,
      async (tx, team) => {
        await tx
          .update(siteSkillSettings)
          .set({ registryTeamId: team.id, updatedBy: adminId, updatedAt: new Date() })
          .where(eq(siteSkillSettings.id, 1));
        await joinRegistryTeamInTx(tx, team.id, await reviewerIds(tx));
        await recordAudit(tx, {
          action: "skill.registry.settings_updated",
          target: { changed: ["registryTeamId"], registryTeamId: team.id },
        });
      },
    );
  } catch (err) {
    if (pgCode(err) !== "23505") throw err;
    const exists = (await registryTeamFor(db)) !== null;
    return exists
      ? { ok: false, code: "registry_exists", message: "The Registry team already exists." }
      : { ok: false, code: "slug_taken", message: "A team with that slug already exists." };
  }
  return { ok: true, settings: await readRegistrySettings(db) };
}
