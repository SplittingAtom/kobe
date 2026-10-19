import { sql, type KobeDb, type KobeTx } from "@kobe/db";
import { recordAudit } from "../../audit/record.js";
import { blockedAmong } from "../blocklist.js";
import { listMaintainers, recordFirstMaintainer } from "./maintainers.js";
import { confirmerOf, dutiesProblem } from "./review-duties.js";
import { authoritativeScorecardProblem, isSiteAdmin, siteJudge } from "./review-guards.js";
import { cautionKeys, unacknowledgedProblem } from "./review-findings.js";
import { DECIDABLE_STATES, PROBLEMS, type Problem } from "./review-problems.js";
import { versionRow, type VersionRow } from "./review-queue.js";
import { inRegistryTx } from "./registry-tx.js";
import { cancelOpenReruns } from "./rerun.js";
import { requireRegistryTeam } from "./settings.js";

/**
 * Approve (KOBE-334, SK23): publishes a reviewed version to the Catalog. One transaction, which
 * fails closed on every check before it writes:
 *
 * 1. the Registry team, read under its share lock (`requireRegistryTeam`, SK21);
 * 2. the version, locked `FOR UPDATE`, still Submitted or In review (the first decision wins),
 *    and not claimed by another reviewer;
 * 3. the authoritative scorecard (KOBE-335's re-run; until then "authoritative scorecard missing");
 *    the package not on the site blocklist (D22), and a Block verdict only by a Site admin (SK32,
 *    an override the audit row records with the verdict);
 * 4. separation of duties (SK22): not the submitter's own, not the confirming Team admin's, except
 *    on a single-admin Site (the database decides and flags the submitter's case itself);
 * 5. the submitter may still submit under this name: once the skill has maintainers, only an
 *    active one (a name freed after a rejection can't be approved for two people); the catalog
 *    skill row is locked first, so two first approvals can't both find no maintainer (review L1);
 *    an archived skill takes nothing more, a deactivated submitter can't become its maintainer;
 * 6. every Caution finding acknowledged (review M1), and a note for a Block override (L3).
 *
 * Then: the review (reviewer, time; the database sets `self_approved`), the first maintainer
 * (`recordFirstMaintainer`), the catalog summary from the approved manifest, the review event and
 * `registry.approved`.
 */

export {
  DECIDABLE_STATES,
  PROBLEMS,
  REJECTABLE_STATES,
  type Problem,
  type ProblemCode,
} from "./review-problems.js";

export { confirmerOf, dutiesProblem } from "./review-duties.js";

async function maintainerProblem(tx: KobeTx, v: VersionRow): Promise<Problem | null> {
  const all = await listMaintainers(tx, v.skillId);
  if (all.length === 0) return null;
  if (all.some((m) => m.userId === v.submittedBy && !m.deactivated)) return null;
  return {
    code: "not_maintainer",
    message: `The submitter no longer maintains ${v.name}: reject this version.`,
  };
}

/** Every reason `userId` can't approve `v` now, in the order Approve checks them. */
export async function approveProblems(
  tx: KobeTx,
  v: VersionRow | undefined,
  userId: string,
  input?: DecisionInput,
): Promise<{ problems: Problem[]; sole: boolean }> {
  const problems: Problem[] = [];
  const registry = await requireRegistryTeam(tx);
  if (registry.ok === false) problems.push(PROBLEMS.registry_not_ready);
  if (!v) return { problems: [...problems, PROBLEMS.not_found], sole: false };
  if (!DECIDABLE_STATES.has(v.state)) problems.push(PROBLEMS.decided);
  else if (v.claimedBy !== null && v.claimedBy !== userId) problems.push(PROBLEMS.claimed);
  const judge = await siteJudge(tx);
  const card = authoritativeScorecardProblem(v, {
    registryTeamId: registry.ok ? registry.teamId : null,
    siteJudgeAlias: judge.alias,
    siteJudgeModel: judge.model,
    at: new Date(),
  });
  if (card) problems.push(card as Problem);
  if ((await blockedAmong(tx, [v.runtimeHash, v.packageHash])).length > 0)
    problems.push(PROBLEMS.blocked);
  if (v.verdict === "block" && !(await isSiteAdmin(tx, userId)))
    problems.push(PROBLEMS.block_verdict);
  else if (v.verdict === "block" && input && !input.note)
    problems.push(PROBLEMS.scan_override_reason);
  const findings = await unacknowledgedProblem(tx, v.id, v.scan);
  if (findings) problems.push(findings);
  const duties = await dutiesProblem(tx, v, userId);
  if (duties.problem) problems.push(duties.problem);
  // The catalog skill row, locked when approving: maintainers are decided one approval at a time
  // (review L1). The review screen's read (no input) takes no lock.
  const skill = await tx.execute<{ status: string; deactivated: boolean }>(sql`
    SELECT s.status, (u.deactivated_at IS NOT NULL) AS deactivated
      FROM registry_skills s LEFT JOIN users u ON u.id = ${v.submittedBy}
     WHERE s.id = ${v.skillId} ${input ? sql`FOR UPDATE OF s` : sql``}`);
  if (skill.rows[0]?.status === "archived") problems.push(PROBLEMS.archived);
  if (skill.rows[0]?.deactivated) problems.push(PROBLEMS.submitter_deactivated);
  const right = await maintainerProblem(tx, v);
  if (right) problems.push(right);
  return { problems, sole: duties.sole };
}

export interface DecisionInput {
  readonly note: string | null;
  readonly checklist: Readonly<Record<string, boolean | undefined>> | null;
}

export type ApproveResult =
  | { readonly ok: true; readonly version: VersionRow; readonly selfApproved: boolean }
  | { readonly ok: false; readonly problem: Problem };

/** Thrown inside the transaction to roll back with a problem. */
class Refused extends Error {
  constructor(readonly problem: Problem) {
    super(problem.message);
  }
}

const isInsufficientPrivilege = (err: unknown) => {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  return (e.cause?.code ?? e.code) === "42501";
};

export async function approve(
  db: KobeDb,
  versionId: string,
  userId: string,
  input: DecisionInput,
): Promise<ApproveResult> {
  try {
    return await inRegistryTx(db, async (tx, registryTeamId) => {
      const v = await versionRow(tx, versionId, true);
      const { problems, sole } = await approveProblems(tx, v, userId, input);
      const first = problems[0];
      if (first || !v) throw new Refused(first ?? PROBLEMS.not_found);
      const res = await tx.execute<{ self_approved: boolean }>(sql`
        UPDATE registry_versions
           SET state = 'approved', reviewed_by = ${userId}, approved_at = now(),
               claimed_by = NULL, claimed_at = NULL, updated_at = now()
         WHERE id = ${v.id}
        RETURNING self_approved`);
      const selfApproved = res.rows[0]?.self_approved === true;
      if (!v.submittedBy) throw new Error("a maintainer version has a submitter");
      await recordFirstMaintainer(tx, v.skillId, v.submittedBy);
      const summary = typeof v.manifest.summary === "string" ? v.manifest.summary : null;
      if (summary)
        await tx.execute(sql`
          UPDATE registry_skills SET summary = ${summary.slice(0, 280)}, updated_at = now()
           WHERE id = ${v.skillId} AND summary IS DISTINCT FROM ${summary.slice(0, 280)}`);
      await tx.execute(sql`
        INSERT INTO registry_review_events (version_id, actor_id, action, note, checklist)
        VALUES (${v.id}, ${userId}, 'approved', ${input.note},
          ${input.checklist ? JSON.stringify(input.checklist) : null}::jsonb)`);
      const confirmerApproved = sole && confirmerOf(v) === userId && v.submittedBy !== userId;
      await recordAudit(tx, {
        action: "registry.approved",
        target: {
          registryVersionId: v.id,
          skillId: v.skillId,
          name: v.name,
          semver: v.semver,
          selfApproved,
          verdict: v.verdict as "pass" | "caution" | "block",
          ...(v.verdict === "block" ? { scanOverride: true } : {}),
          acknowledgedFindings: cautionKeys(v.scan).length,
          ...(confirmerApproved ? { confirmerApproved } : {}),
        },
      });
      if (registryTeamId) await cancelOpenReruns(tx, registryTeamId, v.id);
      return { ok: true as const, version: { ...v, state: "approved" }, selfApproved };
    });
  } catch (err) {
    if (err instanceof Refused) return { ok: false, problem: err.problem };
    // The database's own separation-of-duties guard (0133, 0161) refused the submitter or the
    // confirmer.
    if (isInsufficientPrivilege(err)) return { ok: false, problem: PROBLEMS.own_submission };
    throw err;
  }
}
