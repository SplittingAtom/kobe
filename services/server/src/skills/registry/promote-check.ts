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
  /** The payload (what agents load) and kobe.skill.yaml, which leaves too (review C4-L3). */
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
    if (path.endsWith("/")) continue;
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

/** A team version's review row, as `teamReviewRefusal` reads it. */
export interface TeamReviewRow {
  readonly status: string | null;
  readonly suspended: boolean;
}

/**
 * D22 (review C4-M2): only a version the team's own review approved, and not suspended by a
 * rescan, may leave the team; null when it may.
 */
export function teamReviewRefusal(row: TeamReviewRow | undefined): Refusal | null {
  if (row?.status === "approved" && !row.suspended) return null;
  return {
    code: "team_review",
    message:
      row?.status === "rejected"
        ? "The team's review rejected this version: only an approved version can be promoted."
        : row?.suspended
          ? "A rescan suspended this version: the team's review must decide it again first."
          : "The team's review hasn't approved this version yet: a Team admin approves it first.",
  };
}

/**
 * The team's review of a version, its row held `FOR SHARE` until the transaction ends (re-review
 * LOW-R2): submit re-checks it there, so a rejection or suspension landing after the preview
 * check waits for the submission or wins over it.
 */
export async function lockedTeamReview(
  tx: KobeTx,
  source: PromoteSource,
): Promise<TeamReviewRow | undefined> {
  const res = await tx.execute<{ status: string; suspended: boolean }>(sql`
    SELECT status, suspended_at IS NOT NULL AS suspended FROM team_skill_reviews
     WHERE team_id = ${source.teamId} AND scope = 'team' AND skill_id = ${source.skillId}
       AND version = ${source.version}
     FOR SHARE`);
  return res.rows[0];
}

/**
 * The version's own flags (KOBE-333 review): whether it came from a conversation (stored at save,
 * through forks too, C4-M3) and, for a team version, its team review (D22, C4-M2).
 */
async function versionFacts(db: KobeDb, source: PromoteSource) {
  return withTeam(db, source.teamId, async (tx: KobeTx) => {
    if (source.scope === "personal") {
      const res = await tx.execute<{ flag: boolean }>(sql`
        SELECT from_conversation AS flag FROM personal_skill_versions
         WHERE skill_id = ${source.skillId} AND version = ${source.version}`);
      return { fromConversation: res.rows[0]?.flag === true, review: null };
    }
    const res = await tx.execute<{ flag: boolean; status: string | null; suspended: boolean }>(sql`
      SELECT v.from_conversation AS flag, r.status, r.suspended_at IS NOT NULL AS suspended
        FROM team_skill_versions v
        LEFT JOIN team_skill_reviews r
          ON r.team_id = v.team_id AND r.skill_id = v.skill_id AND r.version = v.version
         AND r.scope = 'team'
       WHERE v.team_id = ${source.teamId} AND v.skill_id = ${source.skillId}
         AND v.version = ${source.version}`);
    const row = res.rows[0];
    return { fromConversation: row?.flag === true, review: teamReviewRefusal(row) };
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
    const res = await db.execute<{ semver: string; state: string }>(sql`
      SELECT semver, state FROM registry_versions WHERE skill_id = ${catalogSkillId}`);
    // A rejected version keeps its number (the Registry keeps it) but sets no floor: a name freed
    // after a rejection starts again at any version (KOBE-334).
    const semvers = res.rows.filter((r) => r.state !== "rejected").map((r) => r.semver);
    if (res.rows.some((r) => r.semver === plan.semver))
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
  const facts = await versionFacts(db, source);
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
    fromConversation: facts.fromConversation,
  };
  const { refusals, catalogSkillId } = await refusalsOf(
    db,
    settings.submissionRules,
    base,
    submitterId,
  );
  return {
    ok: true,
    plan: {
      ...base,
      refusals: facts.review ? [facts.review, ...refusals] : refusals,
      catalogSkillId,
    },
  };
}
