import { sql, type KobeDb, type KobeTx } from "@kobe/db";
import { recordAudit } from "../../audit/record.js";
import { listMaintainers, recordFirstMaintainer } from "./maintainers.js";
import { authoritativeScorecardProblem, soleReviewer } from "./review-guards.js";
import { versionRow, type VersionRow } from "./review-queue.js";
import { requireRegistryTeam } from "./settings.js";

/**
 * Approve (KOBE-334, SK23): publishes a reviewed version to the Catalog. One transaction, which
 * fails closed on every check before it writes:
 *
 * 1. the Registry team, read under its share lock (`requireRegistryTeam`, SK21);
 * 2. the version, locked `FOR UPDATE`, still Submitted or In review (the first decision wins),
 *    and not claimed by another reviewer;
 * 3. the authoritative scorecard (KOBE-335's re-run; until then "authoritative scorecard missing");
 * 4. separation of duties (SK22): not the submitter's own, not the confirming Team admin's, except
 *    on a single-admin Site (the database decides and flags the submitter's case itself);
 * 5. the submitter may still submit under this name: once the skill has maintainers, only an
 *    active one (a name freed after a rejection can't be approved for two people).
 *
 * Then: the review (reviewer, time; the database sets `self_approved`), the first maintainer
 * (`recordFirstMaintainer`), the catalog summary from the approved manifest, the review event and
 * `registry.approved`.
 */

export interface Problem {
  readonly code: ProblemCode;
  readonly message: string;
}

export type ProblemCode =
  | "registry_not_ready"
  | "not_found"
  | "decided"
  | "claimed"
  | "authoritative_scorecard_missing"
  | "authoritative_scorecard_stale"
  | "own_submission"
  | "confirmed_by_you"
  | "not_maintainer";

export const DECIDABLE_STATES: ReadonlySet<string> = new Set(["submitted", "in_review"]);

export const PROBLEMS = {
  registry_not_ready: {
    code: "registry_not_ready",
    message: "The Registry is not ready: a Site admin creates the Registry team first.",
  },
  not_found: { code: "not_found", message: "No such Registry version." },
  decided: { code: "decided", message: "This version was already decided." },
  claimed: { code: "claimed", message: "Another reviewer has claimed this version." },
  own_submission: {
    code: "own_submission",
    message: "You submitted this version: another reviewer must decide it.",
  },
  confirmed_by_you: {
    code: "confirmed_by_you",
    message: "You confirmed this promotion as Team admin: another reviewer must approve it.",
  },
} as const satisfies Record<string, Problem>;

/** The Team admin who confirmed a Builder's promotion (provenance `confirmedBy`), if any. */
export function confirmerOf(v: Pick<VersionRow, "provenance">): string | null {
  const c = v.provenance.confirmedBy as { userId?: unknown } | undefined;
  return typeof c?.userId === "string" ? c.userId : null;
}

/** Whether `userId` decides `v` against SK22, and whether the single-admin exception applies. */
export async function dutiesProblem(
  tx: KobeTx,
  v: VersionRow,
  userId: string,
): Promise<{ problem: Problem | null; sole: boolean }> {
  const own = v.submittedBy === userId;
  const confirmed = confirmerOf(v) === userId;
  if (!own && !confirmed) return { problem: null, sole: false };
  if (await soleReviewer(tx, userId)) return { problem: null, sole: true };
  return { problem: own ? PROBLEMS.own_submission : PROBLEMS.confirmed_by_you, sole: false };
}

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
): Promise<{ problems: Problem[]; sole: boolean }> {
  const problems: Problem[] = [];
  if ((await requireRegistryTeam(tx)).ok === false) problems.push(PROBLEMS.registry_not_ready);
  if (!v) return { problems: [...problems, PROBLEMS.not_found], sole: false };
  if (!DECIDABLE_STATES.has(v.state)) problems.push(PROBLEMS.decided);
  else if (v.claimedBy !== null && v.claimedBy !== userId) problems.push(PROBLEMS.claimed);
  const card = authoritativeScorecardProblem(v);
  if (card) problems.push(card as Problem);
  const duties = await dutiesProblem(tx, v, userId);
  if (duties.problem) problems.push(duties.problem);
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
    return await db.transaction(async (tx) => {
      const v = await versionRow(tx, versionId, true);
      const { problems, sole } = await approveProblems(tx, v, userId);
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
          ...(confirmerApproved ? { confirmerApproved } : {}),
        },
      });
      return { ok: true as const, version: { ...v, state: "approved" }, selfApproved };
    });
  } catch (err) {
    if (err instanceof Refused) return { ok: false, problem: err.problem };
    // The database's own separation-of-duties guard (0133) refused the submitter.
    if (isInsufficientPrivilege(err)) return { ok: false, problem: PROBLEMS.own_submission };
    throw err;
  }
}
