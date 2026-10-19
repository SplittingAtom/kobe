import { unzipSync } from "fflate";
import {
  scorecardForProvenance,
  skillEvalScorecardSchema,
  skillEvalSubmissionShortfalls,
  type CatalogSkillEvalScorecard,
  type RegistrySubmissionRules,
} from "@kobe/protocol";
import type { ScanResult } from "@kobe/skill-scanner";
import { sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { validateZipBundle, type ValidBundle } from "../bundle.js";
import { scanCanonicalZip } from "../review.js";
import { compareSemver } from "../semver.js";
import type { SkillStore } from "../skill-store.js";
import type { SkillLocation } from "../store.js";
import { submissionRight } from "./maintainers.js";
import { readRegistrySettings } from "./settings.js";

/**
 * What a promotion would send and whether SK20's rules let it (KOBE-333, SK19, SK20): read only,
 * so the Workbench shows it before anything leaves the team (the Team admin's confirmation shows
 * the same). The package is the version's own stored package (verified by hash, through the
 * SkillStore); the scan is run again on it; the scorecard is the team's newest full eval of this
 * exact package (numbers only, `scorecardForProvenance`). Every refusal carries its reason.
 */

export interface PromoteSource {
  readonly scope: "team" | "personal";
  /** The active team: the source team (SK24), where its eval ran and its audit goes. */
  readonly teamId: string;
  readonly skillId: string;
  readonly version: number;
}

export interface PackageFile {
  readonly path: string;
  readonly size: number;
}

export interface Refusal {
  readonly code: string;
  readonly message: string;
}

export interface PromotionPlan {
  readonly name: string;
  readonly semver: string;
  readonly seq: number;
  readonly bundle: ValidBundle;
  readonly runtimeHash: string;
  readonly scan: ScanResult;
  readonly scorecard: CatalogSkillEvalScorecard | null;
  /** The payload: what agents load. */
  readonly files: readonly PackageFile[];
  /** `evals/`: cases and fixtures, which leave the team too. */
  readonly fixtures: readonly PackageFile[];
  readonly fromConversation: boolean;
  /** The catalog skill it would be a version of; null for a new name. */
  readonly catalogSkillId: string | null;
  readonly refusals: readonly Refusal[];
}

export type PrepareResult =
  | { readonly ok: true; readonly plan: PromotionPlan }
  | { readonly ok: false; readonly code: "not_found" | "legacy"; readonly message: string };

const NOT_FOUND = { ok: false, code: "not_found", message: "No such version." } as const;

const SHORTFALL: Record<string, string> = {
  stale: "The scorecard is from another package: run the evals of this version again.",
  too_few_cases: "Too few eval cases.",
  no_negative_trigger_case: "The suite needs a negative trigger case (triggers: false).",
  pass_rate: "The pass rate with the skill is below the Site's minimum.",
  lift: "The lift over the no-skill baseline is below the Site's minimum (or unknown).",
  trigger_precision: "Trigger precision is below the Site's minimum (or unknown).",
};

function filesOf(bundle: ValidBundle) {
  const entries = Object.entries(unzipSync(bundle.packageZip ?? bundle.zip));
  const files: PackageFile[] = [];
  const fixtures: PackageFile[] = [];
  for (const [path, bytes] of entries) {
    if (path.endsWith("/") || path === "kobe.skill.yaml") continue;
    (path.startsWith("evals/") ? fixtures : files).push({ path, size: bytes.length });
  }
  const byPath = (a: PackageFile, b: PackageFile) => (a.path < b.path ? -1 : 1);
  return { files: files.sort(byPath), fixtures: fixtures.sort(byPath) };
}

/** The team's newest full eval of this skill version's package (fresh), or of the skill. */
async function scorecardOf(
  db: KobeDb,
  source: PromoteSource,
  packageHash: string,
  fresh: boolean,
): Promise<CatalogSkillEvalScorecard | null> {
  const row = await withTeam(db, source.teamId, async (tx) => {
    const res = await tx.execute<{ scorecard: unknown; finished_at: Date }>(sql`
      SELECT scorecard, finished_at FROM skill_eval_runs
       WHERE team_id = ${source.teamId} AND subject_kind = ${source.scope}
         AND subject_id = ${source.skillId} AND mode = 'full' AND status = 'completed'
         AND scorecard IS NOT NULL
         AND (${!fresh} OR package_hash = ${packageHash})
       ORDER BY finished_at DESC NULLS LAST LIMIT 1`);
    return res.rows[0];
  });
  if (!row) return null;
  const card = skillEvalScorecardSchema.safeParse(row.scorecard);
  if (!card.success) return null;
  return scorecardForProvenance(card.data, new Date(row.finished_at).toISOString());
}

/**
 * Whether the version was saved from a Workbench draft that started from a conversation (SK19),
 * read from the team's own audit rows (never rewritten, so a deleted draft still answers).
 */
async function fromConversation(db: KobeDb, source: PromoteSource, semver: string) {
  return withTeam(db, source.teamId, async (tx: KobeTx) => {
    const res =
      source.scope === "team"
        ? await tx.execute<{ thread: boolean }>(sql`
            SELECT EXISTS (
              SELECT 1 FROM audit_log u JOIN audit_log d
                ON d.team_id = u.team_id AND d.action = 'skill.draft.created'
               AND d.target ->> 'draftId' = u.target ->> 'draftId'
             WHERE u.team_id = ${source.teamId} AND u.action = 'skill.uploaded'
               AND u.target ->> 'skillId' = ${source.skillId}
               AND u.target ->> 'version' = ${String(source.version)}
               AND d.target ->> 'startedFrom' = 'thread') AS thread`)
        : await tx.execute<{ thread: boolean }>(sql`
            SELECT EXISTS (
              SELECT 1 FROM audit_log p
               WHERE p.team_id = ${source.teamId} AND p.action = 'skill.draft.personalized'
                 AND p.target ->> 'skillId' = ${source.skillId}
                 AND p.target ->> 'semver' = ${semver}
                 AND (p.target ->> 'fromConversation')::boolean) AS thread`);
    return res.rows[0]?.thread === true;
  });
}

/** SK20's rules (and the catalog's own) against the package. */
async function refusalsOf(
  db: KobeDb,
  rules: RegistrySubmissionRules,
  plan: Omit<PromotionPlan, "refusals" | "catalogSkillId">,
  submitterId: string,
): Promise<{ refusals: Refusal[]; catalogSkillId: string | null }> {
  const out: Refusal[] = [];
  const right = await submissionRight(db, plan.name, submitterId);
  if (!right.ok) out.push({ code: right.code, message: right.message });
  const catalogSkillId = right.ok ? (right.skill?.id ?? null) : null;
  if (catalogSkillId) {
    const res = await db.execute<{ semver: string }>(sql`
      SELECT semver FROM registry_versions WHERE skill_id = ${catalogSkillId}`);
    const semvers = res.rows.map((r) => r.semver);
    if (semvers.includes(plan.semver))
      out.push({ code: "already_submitted", message: `${plan.semver} was already submitted.` });
    else if (semvers.some((v) => compareSemver(v, plan.semver) > 0))
      out.push({
        code: "not_newer",
        message: `${plan.semver} is older than a version already in the Registry.`,
      });
  }
  if (!plan.bundle.manifest)
    out.push({ code: "no_manifest", message: "The package needs a kobe.skill.yaml." });
  else if (rules.requireLicense && !plan.bundle.manifest.license)
    out.push({
      code: "license",
      message: "kobe.skill.yaml needs a license (Proprietary is fine).",
    });
  if (rules.refuseBlockVerdict && plan.scan.verdict === "block")
    out.push({ code: "scan_block", message: "The scanner blocks this package." });
  if (!plan.scorecard)
    out.push({
      code: "no_scorecard",
      message: "Run the full evals of this version (with and without the skill) first.",
    });
  else {
    const shortfalls = skillEvalSubmissionShortfalls(plan.scorecard, plan.bundle.packageHash, {
      minCases: rules.minCases,
      minNegativeTriggerCases: rules.minNegativeCases,
      minPassRate: rules.minPassRate,
      minLift: rules.minLift,
      minTriggerPrecision: rules.minTriggerPrecision,
    }).filter((s) => rules.requireFreshScorecard || s !== "stale");
    for (const s of shortfalls) out.push({ code: s, message: SHORTFALL[s] ?? s });
  }
  return { refusals: out, catalogSkillId };
}

export async function preparePromotion(
  db: KobeDb,
  store: SkillStore,
  source: PromoteSource,
  submitterId: string,
): Promise<PrepareResult> {
  const location: SkillLocation =
    source.scope === "team"
      ? { scope: "team", teamId: source.teamId }
      : { scope: "personal", ownerUserId: submitterId };
  const [exported] = await store.export(location, source.skillId, {
    fromSeq: source.version,
    toSeq: source.version,
  });
  if (!exported) return NOT_FOUND;
  const { version } = exported;
  if ("legacy" in exported)
    return {
      ok: false,
      code: "legacy",
      message: `This version can't leave the team until it is saved again (${exported.legacy.join(", ")}).`,
    };
  const checked = validateZipBundle(exported.bytes);
  if (!checked.ok) return NOT_FOUND;
  const bundle = checked.value;
  const settings = await readRegistrySettings(db);
  const base = {
    name: bundle.name,
    semver: version.semver,
    seq: version.seq,
    bundle,
    runtimeHash: exported.runtimeHash,
    scan: await scanCanonicalZip(bundle.packageZip ?? bundle.zip),
    scorecard: await scorecardOf(
      db,
      source,
      bundle.packageHash,
      settings.submissionRules.requireFreshScorecard,
    ),
    ...filesOf(bundle),
    fromConversation: await fromConversation(db, source, version.semver),
  };
  const { refusals, catalogSkillId } = await refusalsOf(
    db,
    settings.submissionRules,
    base,
    submitterId,
  );
  return { ok: true, plan: { ...base, refusals, catalogSkillId } };
}
