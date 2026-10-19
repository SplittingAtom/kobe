import { sql, type KobeDb, type KobeTx } from "@kobe/db";
import { recordAudit } from "../../audit/record.js";
import { addBlockedInTx } from "../blocklist.js";
import {
  DECIDABLE_STATES,
  PROBLEMS,
  dutiesProblem,
  type DecisionInput,
  type Problem,
} from "./review-approve.js";
import { versionRow, type VersionRow } from "./review-queue.js";

/**
 * The Registry review's other actions (KOBE-334, SK23): claim and release, comment, Request
 * changes, Reject and Reject and block. Each locks the version row, so the first decision wins;
 * a decision needs the version Submitted or In review and not claimed by another reviewer; and
 * nobody claims or decides their own submission (a single-admin Site excepted: it may claim to
 * approve, SK22; the database refuses anything but an approval by the submitter).
 */

export type ReviewResult =
  | { readonly ok: true; readonly version: VersionRow; readonly changed: boolean }
  | { readonly ok: false; readonly problem: Problem };

class Refused extends Error {
  constructor(readonly problem: Problem) {
    super(problem.message);
  }
}

async function locked(
  db: KobeDb,
  versionId: string,
  fn: (tx: KobeTx, v: VersionRow) => Promise<{ version: VersionRow; changed: boolean }>,
): Promise<ReviewResult> {
  try {
    return await db.transaction(async (tx) => {
      const v = await versionRow(tx, versionId, true);
      if (!v || v.publisher !== "maintainer") throw new Refused(PROBLEMS.not_found);
      return { ok: true as const, ...(await fn(tx, v)) };
    });
  } catch (err) {
    if (err instanceof Refused) return { ok: false, problem: err.problem };
    throw err;
  }
}

const event = (
  tx: KobeTx,
  versionId: string,
  actor: string,
  action: string,
  input?: DecisionInput,
) =>
  tx.execute(sql`
    INSERT INTO registry_review_events (version_id, actor_id, action, note, checklist)
    VALUES (${versionId}, ${actor}, ${action}::registry_review_action, ${input?.note ?? null},
      ${input?.checklist ? JSON.stringify(input.checklist) : null}::jsonb)`);

/** Claims the version: Submitted → In review, held by `userId`. Claiming one's own claim is a no-op. */
export function claim(db: KobeDb, versionId: string, userId: string): Promise<ReviewResult> {
  return locked(db, versionId, async (tx, v) => {
    if (!DECIDABLE_STATES.has(v.state)) throw new Refused(PROBLEMS.decided);
    if (v.claimedBy === userId) return { version: v, changed: false };
    if (v.claimedBy !== null) throw new Refused(PROBLEMS.claimed);
    if (v.submittedBy === userId) {
      const duties = await dutiesProblem(tx, v, userId);
      if (duties.problem) throw new Refused(duties.problem);
    }
    await tx.execute(sql`
      UPDATE registry_versions
         SET state = 'in_review', claimed_by = ${userId}, claimed_at = now(), updated_at = now()
       WHERE id = ${v.id}`);
    await event(tx, v.id, userId, "claimed");
    await recordAudit(tx, { action: "registry.claimed", target: { registryVersionId: v.id } });
    return { version: { ...v, state: "in_review", claimedBy: userId }, changed: true };
  });
}

/**
 * Lets go of a claim: In review → Submitted. The claimer may, and so may a reviewer who holds
 * every Registry action (`mayTakeOver`: Site admins), so an abandoned claim never blocks the queue.
 */
export function unclaim(
  db: KobeDb,
  versionId: string,
  userId: string,
  mayTakeOver: boolean,
): Promise<ReviewResult> {
  return locked(db, versionId, async (tx, v) => {
    if (v.claimedBy === null) return { version: v, changed: false };
    if (v.claimedBy !== userId && !mayTakeOver) throw new Refused(PROBLEMS.claimed);
    await tx.execute(sql`
      UPDATE registry_versions
         SET state = 'submitted', claimed_by = NULL, claimed_at = NULL, updated_at = now()
       WHERE id = ${v.id} AND state = 'in_review'`);
    await event(tx, v.id, userId, "unclaimed");
    await recordAudit(tx, { action: "registry.unclaimed", target: { registryVersionId: v.id } });
    return { version: { ...v, state: "submitted", claimedBy: null }, changed: true };
  });
}

/** A reviewer's comment on the version; it stays in the Registry's history. */
export function comment(
  db: KobeDb,
  versionId: string,
  userId: string,
  note: string,
): Promise<ReviewResult> {
  return locked(db, versionId, async (tx, v) => {
    await event(tx, v.id, userId, "commented", { note, checklist: null });
    await recordAudit(tx, { action: "registry.commented", target: { registryVersionId: v.id } });
    return { version: v, changed: true };
  });
}

export type Verdict = "request_changes" | "reject" | "reject_and_block";

const VERDICT: Readonly<Record<Verdict, { state: string; action: string; blocked: boolean }>> = {
  request_changes: { state: "changes_requested", action: "changes_requested", blocked: false },
  reject: { state: "rejected", action: "rejected", blocked: false },
  reject_and_block: { state: "rejected", action: "rejected_and_blocked", blocked: true },
};

/**
 * Request changes (the note goes back to the author's Workbench), Reject, or Reject and block
 * (Site admins; the route checks): the runtime hash joins the site blocklist in the same
 * transaction, so the package never loads anywhere.
 */
export function decide(
  db: KobeDb,
  versionId: string,
  userId: string,
  verdict: Verdict,
  input: DecisionInput,
): Promise<ReviewResult> {
  const plan = VERDICT[verdict];
  return locked(db, versionId, async (tx, v) => {
    if (!DECIDABLE_STATES.has(v.state)) throw new Refused(PROBLEMS.decided);
    if (v.claimedBy !== null && v.claimedBy !== userId) throw new Refused(PROBLEMS.claimed);
    // Only an approval may be the submitter's own (a single-admin Site's): the database refuses
    // the rest. The confirming Team admin may send it back or reject it (only approving is theirs
    // to sit out, review-c2 (b)).
    if (v.submittedBy === userId) throw new Refused(PROBLEMS.own_submission);
    await tx.execute(sql`
      UPDATE registry_versions
         SET state = ${plan.state}::registry_version_state, reviewed_by = ${userId},
             claimed_by = NULL, claimed_at = NULL, updated_at = now()
       WHERE id = ${v.id}`);
    if (plan.blocked)
      await addBlockedInTx(tx, {
        hash: v.runtimeHash,
        reason: `Rejected and blocked in the Registry review: ${v.name} ${v.semver}`,
        userId,
      });
    await event(tx, v.id, userId, plan.action, input);
    await recordAudit(
      tx,
      verdict === "request_changes"
        ? { action: "registry.changes_requested", target: { registryVersionId: v.id } }
        : {
            action: "registry.rejected",
            target: { registryVersionId: v.id, blocked: plan.blocked },
          },
    );
    return { version: { ...v, state: plan.state, claimedBy: null }, changed: true };
  });
}
