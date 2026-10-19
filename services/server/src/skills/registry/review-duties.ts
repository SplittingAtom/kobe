import type { KobeTx } from "@kobe/db";
import { soleReviewer } from "./review-guards.js";
import { PROBLEMS, type Problem } from "./review-problems.js";
import type { VersionRow } from "./review-queue.js";

/**
 * Separation of duties for every Registry review act that weighs a version (SK22): Approve,
 * acknowledging its Caution findings, starting or cancelling its re-runs. Neither its submitter
 * nor the Team admin who confirmed its promotion may, except on a single-admin Site (the
 * database flags that approval `self_approved`).
 */

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
