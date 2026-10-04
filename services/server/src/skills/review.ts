import { unzipSync } from "fflate";
import { scanSkillBundle, type ScanResult } from "@kobe/skill-scanner";
import {
  and,
  desc,
  eq,
  inArray,
  teamSkillReviews,
  teamSkills,
  teamSkillVersions,
  withTeam,
  type KobeDb,
  type KobeTx,
  type SkillReviewStatus,
  type StoredFinding,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";

/**
 * Scan results and team-admin review of team skill versions (KOBE-80, spec D22). Every new team
 * version gets a `pending` review row in the upload's transaction, with the scanner's findings;
 * nothing but an `approved` row makes a version usable. Flagged versions (any finding) are marked
 * so the queue shows them first, but unflagged ones need the same approval (D22 default).
 * Personal skills have no team to review them and are scanned for the record only.
 */

/** Scans the files of a canonical zip (the exact bytes that are stored and hashed). */
export function scanCanonicalZip(zip: Uint8Array): ScanResult {
  const entries = unzipSync(zip);
  return scanSkillBundle(Object.entries(entries).map(([path, bytes]) => ({ path, bytes })));
}

/** Creates the pending review row of a just-inserted team version (inside its transaction). */
export async function recordPendingReview(
  tx: KobeTx,
  at: { teamId: string; skillId: string; version: number },
  scan: ScanResult,
): Promise<void> {
  await tx.insert(teamSkillReviews).values({
    ...at,
    flagged: scan.findings.length > 0,
    findings: scan.findings.map((f) => ({ ...f })),
    scripts: [...scan.scripts],
    skipped: [...scan.skipped],
  });
}

export interface ReviewRecord {
  readonly skillId: string;
  readonly slug: string;
  readonly version: number;
  readonly contentHash: string;
  readonly status: SkillReviewStatus;
  readonly flagged: boolean;
  readonly findings: readonly StoredFinding[];
  readonly scripts: readonly string[];
  readonly skipped: readonly string[];
  readonly scannedAt: Date;
  readonly reviewedBy: string | null;
  readonly reviewedAt: Date | null;
  readonly reviewNote: string | null;
}

const COLUMNS = {
  skillId: teamSkillReviews.skillId,
  slug: teamSkills.slug,
  version: teamSkillReviews.version,
  contentHash: teamSkillVersions.contentHash,
  status: teamSkillReviews.status,
  flagged: teamSkillReviews.flagged,
  findings: teamSkillReviews.findings,
  scripts: teamSkillReviews.scripts,
  skipped: teamSkillReviews.skipped,
  scannedAt: teamSkillReviews.scannedAt,
  reviewedBy: teamSkillReviews.reviewedBy,
  reviewedAt: teamSkillReviews.reviewedAt,
  reviewNote: teamSkillReviews.reviewNote,
};

const QUEUE_LIMIT = 200;

/** Review rows joined with their skill and version (inside `withTeam`). */
function joined(tx: KobeTx) {
  return tx
    .select(COLUMNS)
    .from(teamSkillReviews)
    .innerJoin(
      teamSkills,
      and(
        eq(teamSkills.teamId, teamSkillReviews.teamId),
        eq(teamSkills.id, teamSkillReviews.skillId),
      ),
    )
    .innerJoin(
      teamSkillVersions,
      and(
        eq(teamSkillVersions.teamId, teamSkillReviews.teamId),
        eq(teamSkillVersions.skillId, teamSkillReviews.skillId),
        eq(teamSkillVersions.version, teamSkillReviews.version),
      ),
    );
}

/** The team's review rows with the given statuses: flagged first, then oldest scan first. */
export function listReviews(
  db: KobeDb,
  teamId: string,
  statuses: readonly SkillReviewStatus[],
): Promise<ReviewRecord[]> {
  return withTeam(db, teamId, async (tx) => {
    const rows = await joined(tx).where(
      and(eq(teamSkillReviews.teamId, teamId), inArray(teamSkillReviews.status, [...statuses])),
    );
    return rows
      .sort(
        (a, b) =>
          Number(b.flagged) - Number(a.flagged) || a.scannedAt.getTime() - b.scannedAt.getTime(),
      )
      .slice(0, QUEUE_LIMIT);
  });
}

/** Review state of the versions of one team skill, by version number. */
export function reviewsOfSkill(
  db: KobeDb,
  teamId: string,
  skillId: string,
): Promise<Map<number, { status: SkillReviewStatus; flagged: boolean }>> {
  return withTeam(db, teamId, async (tx) => {
    const rows = await tx
      .select({
        version: teamSkillReviews.version,
        status: teamSkillReviews.status,
        flagged: teamSkillReviews.flagged,
      })
      .from(teamSkillReviews)
      .where(and(eq(teamSkillReviews.teamId, teamId), eq(teamSkillReviews.skillId, skillId)));
    return new Map(rows.map((r) => [r.version, { status: r.status, flagged: r.flagged }]));
  });
}

export type DecideResult =
  | { readonly ok: true; readonly review: ReviewRecord }
  | { readonly ok: false; readonly error: "not_found" | "unchanged" };

/** Approves or rejects a version; an earlier decision can be reversed. Audited. */
export function decideReview(
  db: KobeDb,
  teamId: string,
  at: { skillId: string; version: number },
  decision: { status: "approved" | "rejected"; note: string | null; reviewerId: string },
): Promise<DecideResult> {
  const key = and(
    eq(teamSkillReviews.teamId, teamId),
    eq(teamSkillReviews.skillId, at.skillId),
    eq(teamSkillReviews.version, at.version),
  );
  return withTeam(db, teamId, async (tx) => {
    const [current] = await joined(tx).where(key).for("update", { of: teamSkillReviews });
    if (!current) return { ok: false, error: "not_found" };
    if (current.status === decision.status) return { ok: false, error: "unchanged" };
    const reviewedAt = new Date();
    await tx
      .update(teamSkillReviews)
      .set({
        status: decision.status,
        reviewedBy: decision.reviewerId,
        reviewedAt,
        reviewNote: decision.note,
      })
      .where(key);
    await recordAudit(tx, {
      action: "skill.reviewed",
      teamId,
      target: {
        skillId: at.skillId,
        slug: current.slug,
        version: at.version,
        decision: decision.status,
        previous: current.status,
        flagged: current.flagged,
      },
    });
    const review: ReviewRecord = {
      ...current,
      status: decision.status,
      reviewedBy: decision.reviewerId,
      reviewedAt,
      reviewNote: decision.note,
    };
    return { ok: true, review };
  });
}

/**
 * The newest approved version of each named team skill, for the resolver. A newer pending or
 * rejected version never hides an older approved one; a skill with no approved version is absent.
 */
export async function approvedTeamSkills(
  tx: KobeTx,
  teamId: string,
  names: readonly string[],
): Promise<{ name: string; hash: string }[]> {
  if (names.length === 0) return [];
  const rows = await joined(tx)
    .where(
      and(
        eq(teamSkillReviews.teamId, teamId),
        eq(teamSkillReviews.status, "approved"),
        inArray(teamSkills.slug, [...names]),
      ),
    )
    .orderBy(desc(teamSkillReviews.version));
  const newest = new Map<string, string>();
  for (const r of rows) if (!newest.has(r.slug)) newest.set(r.slug, r.contentHash);
  return [...newest].map(([name, hash]) => ({ name, hash }));
}
