import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { z } from "zod";
import { scanSkillBundle, storedVerdict, type ScanResult, type Verdict } from "@kobe/skill-scanner";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  sql,
  personalSkillScans,
  personalSkills,
  personalSkillVersions,
  teamSkillReviews,
  teamSkillVersions,
  withTeam,
  type KobeDb,
  type KobeTx,
  type SkillReviewStatus,
  type StoredFinding,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { logger } from "../logger.js";
import type { BlobStore } from "../retention/blobs.js";
import { blockedAmong, isBlocked } from "./blocklist.js";
import { legacySemver } from "./semver.js";

/**
 * Scan results and team-admin review of team skill versions (KOBE-80, spec D22). Every new team
 * version gets a `pending` review row in the upload's transaction, with the scanner's findings;
 * nothing but an `approved` row makes a version usable. Flagged versions (any finding) are marked
 * so the queue shows them first, but unflagged ones need the same approval (D22 default).
 * A personal skill version with findings (or no scan yet) is unusable in a team until that
 * team's admin approves it there: its review row (scope `personal`) is made when a member's run
 * first meets it. Unflagged personal versions need no review. Review rows copy the slug and hash
 * (versions are immutable), so the queue reads one table.
 */

/** Scans the files of a canonical zip (the exact bytes that are stored and hashed). */
export function scanCanonicalZip(zip: Uint8Array): ScanResult {
  const entries = unzipSync(zip);
  return scanSkillBundle(Object.entries(entries).map(([path, bytes]) => ({ path, bytes })));
}

const storedScan = (scan: ScanResult) => ({
  flagged: scan.verdict !== "pass",
  findings: scan.findings.map((f) => ({ ...f })),
  scripts: [...scan.scripts],
  skipped: [...scan.skipped],
});

/** Creates the pending review row of a just-inserted team version (inside its transaction). */
export async function recordPendingReview(
  tx: KobeTx,
  at: { teamId: string; skillId: string; version: number; slug: string; contentHash: string },
  scan: ScanResult,
): Promise<void> {
  await tx.insert(teamSkillReviews).values({ ...at, scope: "team", ...storedScan(scan) });
}

/** Stores the scan of a just-inserted personal version (inside its transaction). */
export async function recordPersonalScan(
  tx: KobeTx,
  at: { skillId: string; version: number },
  scan: ScanResult,
): Promise<void> {
  await tx.insert(personalSkillScans).values({ ...at, ...storedScan(scan) });
}

export interface ReviewRecord {
  readonly skillId: string;
  readonly slug: string;
  readonly version: number;
  /** The version's semver (KOBE-308). */
  readonly semver: string;
  readonly contentHash: string;
  readonly scope: "team" | "personal";
  readonly unscanned: boolean;
  readonly status: SkillReviewStatus;
  readonly flagged: boolean;
  readonly findings: readonly StoredFinding[];
  readonly scripts: readonly string[];
  readonly skipped: readonly string[];
  readonly scannedAt: Date;
  readonly reviewedBy: string | null;
  readonly reviewedAt: Date | null;
  readonly reviewNote: string | null;
  /** The bundle hash is on the site blocklist (KOBE-81): it can't be approved. */
  readonly blocked: boolean;
}

/**
 * The scan verdict of a review row (KOBE-312): from its findings' severities, and Caution for a
 * row stored before KOBE-312 that skipped a file without a finding (review S5).
 */
export const reviewVerdict = (r: {
  readonly findings: readonly StoredFinding[];
  readonly skipped: readonly string[];
}): Verdict => storedVerdict(r);

/**
 * A digest of the scan a reviewer is shown (findings and skipped files, as stored). Approving a
 * Caution or Block scan acknowledges exactly this digest, so findings that change between the
 * look and the click (a late scan, a rescan) are never covered unseen (review S7).
 */
export const findingsDigest = (r: {
  readonly findings: readonly StoredFinding[];
  readonly skipped: readonly string[];
}): string =>
  createHash("sha256")
    .update(JSON.stringify({ findings: r.findings, skipped: r.skipped }))
    .digest("hex");

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const QUEUE_LIMIT = 200;
const SCAN_BATCH = 20;

export interface ReviewPage {
  readonly reviews: ReviewRecord[];
  /** Opaque; pass it back to get the next page. Null on the last page. */
  readonly nextCursor: string | null;
}

interface Cursor {
  readonly flagged: boolean;
  /** `scanned_at` as Postgres prints it (microseconds survive; a JS Date would lose them). */
  readonly at: string;
  readonly skillId: string;
  readonly version: number;
}

const cursorSchema = z.object({
  flagged: z.boolean(),
  at: z.string().max(40),
  skillId: z.uuid(),
  version: z.number().int().positive(),
});

const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString("base64url");

/** Undefined for a malformed cursor (a 400 for the caller). */
export function decodeCursor(value: string): Cursor | undefined {
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(value, "base64url").toString()));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The team's review rows with the given statuses: flagged first, then oldest scan first (ties by
 * skill and version). Sorted and paged in SQL on the (team, status, flagged, scanned_at) index
 * with keyset pagination; the findings are read only for the page's rows.
 */
export function listReviews(
  db: KobeDb,
  teamId: string,
  statuses: readonly SkillReviewStatus[],
  page: { limit?: number; cursor?: Cursor } = {},
): Promise<ReviewPage> {
  const limit = Math.min(page.limit ?? QUEUE_LIMIT, QUEUE_LIMIT);
  return withTeam(db, teamId, async (tx) => {
    const c = page.cursor;
    const after = c
      ? sql`(${teamSkillReviews.flagged} < ${c.flagged}
          OR (${teamSkillReviews.flagged} = ${c.flagged}
            AND (${teamSkillReviews.scannedAt} > ${c.at}::timestamptz
              OR (${teamSkillReviews.scannedAt} = ${c.at}::timestamptz
                AND (${teamSkillReviews.skillId} > ${c.skillId}::uuid
                  OR (${teamSkillReviews.skillId} = ${c.skillId}::uuid
                    AND ${teamSkillReviews.version} > ${c.version}))))))`
      : undefined;
    const keys = await tx
      .select({
        skillId: teamSkillReviews.skillId,
        version: teamSkillReviews.version,
        flagged: teamSkillReviews.flagged,
        at: sql<string>`${teamSkillReviews.scannedAt}::text`,
      })
      .from(teamSkillReviews)
      .where(
        and(
          eq(teamSkillReviews.teamId, teamId),
          inArray(teamSkillReviews.status, [...statuses]),
          after,
        ),
      )
      .orderBy(
        desc(teamSkillReviews.flagged),
        asc(teamSkillReviews.scannedAt),
        asc(teamSkillReviews.skillId),
        asc(teamSkillReviews.version),
      )
      .limit(limit + 1);
    const pageKeys = keys.slice(0, limit);
    const last = pageKeys.at(-1);
    const nextCursor =
      keys.length > limit && last
        ? encodeCursor({
            flagged: last.flagged,
            at: last.at,
            skillId: last.skillId,
            version: last.version,
          })
        : null;
    if (pageKeys.length === 0) return { reviews: [], nextCursor };
    const reviewRows = await tx
      .select(getTableColumns(teamSkillReviews))
      .from(teamSkillReviews)
      .where(
        and(
          eq(teamSkillReviews.teamId, teamId),
          inArray(teamSkillReviews.skillId, [...new Set(pageKeys.map((k) => k.skillId))]),
        ),
      );
    // Blocked through any member of the hash's alias group (KOBE-310).
    const blocked = new Set(
      await blockedAmong(
        tx,
        reviewRows.map((r) => r.contentHash),
      ),
    );
    const rows = reviewRows.map((r) => ({ ...r, blocked: blocked.has(r.contentHash) }));
    const semvers = await semversOf(tx, teamId, rows);
    const byKey = new Map(
      rows.map((r) => {
        const key = `${r.skillId}:${r.version}`;
        return [key, { ...r, semver: semvers.get(key) ?? legacySemver(r.version) }];
      }),
    );
    return {
      reviews: pageKeys.flatMap((k) => byKey.get(`${k.skillId}:${k.version}`) ?? []),
      nextCursor,
    };
  });
}

/**
 * Semvers of reviewed versions by `skillId:version` (KOBE-308): team versions from the team's
 * table (inside `withTeam`), personal ones from the site-wide table.
 */
async function semversOf(
  tx: KobeTx,
  teamId: string,
  rows: readonly { skillId: string; version: number; scope: "team" | "personal" }[],
): Promise<Map<string, string>> {
  const ids = (scope: "team" | "personal") => [
    ...new Set(rows.filter((r) => r.scope === scope).map((r) => r.skillId)),
  ];
  const team = ids("team");
  const personal = ids("personal");
  const found = [
    ...(team.length === 0
      ? []
      : await tx
          .select({
            skillId: teamSkillVersions.skillId,
            version: teamSkillVersions.version,
            semver: teamSkillVersions.semver,
          })
          .from(teamSkillVersions)
          .where(
            and(eq(teamSkillVersions.teamId, teamId), inArray(teamSkillVersions.skillId, team)),
          )),
    ...(personal.length === 0
      ? []
      : await tx
          .select({
            skillId: personalSkillVersions.skillId,
            version: personalSkillVersions.version,
            semver: personalSkillVersions.semver,
          })
          .from(personalSkillVersions)
          .where(inArray(personalSkillVersions.skillId, personal))),
  ];
  return new Map(
    found.map((r) => [`${r.skillId}:${r.version}`, r.semver ?? legacySemver(r.version)]),
  );
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

export type DecideError =
  | "not_found"
  | "unchanged"
  | "blocklisted"
  /** The version was never scanned: it can be rejected, not approved (review S4). */
  | "scan_pending"
  /** The scan is Caution: the reviewer must acknowledge its findings (KOBE-312). */
  | "acknowledgement_required"
  /** The acknowledged findings are not the stored ones any more (review S7). */
  | "findings_changed"
  /** The scan is Block: only a Site admin may approve, with a reason (KOBE-312). */
  | "scan_blocked"
  | "override_reason_required";

export type DecideResult =
  | { readonly ok: true; readonly review: ReviewRecord }
  | { readonly ok: false; readonly error: DecideError };

export interface Decision {
  readonly status: "approved" | "rejected";
  readonly note: string | null;
  readonly reviewerId: string;
  /**
   * The `findingsDigest` of the scan the reviewer read and accepts (required to approve a
   * Caution or Block scan; it must match the stored findings).
   */
  readonly acknowledgedFindings?: string;
  /** The reviewer may override a Block scan (a Site admin, `site.skills.override_scan`). */
  readonly mayOverrideBlock?: boolean;
}

/**
 * Why an approval is refused, if it is: never scanned; Block without a Site admin's override and
 * reason; Caution or Block without acknowledging exactly the stored findings.
 */
function approvalRefusal(
  current: { readonly unscanned: boolean },
  verdict: Verdict,
  digest: string,
  decision: Decision,
): DecideError | null {
  if (current.unscanned) return "scan_pending";
  if (verdict === "block") {
    if (!decision.mayOverrideBlock) return "scan_blocked";
    if (!decision.note) return "override_reason_required";
  }
  if (verdict === "pass") return null;
  if (!decision.acknowledgedFindings) return "acknowledgement_required";
  return decision.acknowledgedFindings === digest ? null : "findings_changed";
}

/**
 * Approves or rejects a version; an earlier decision can be reversed. Audited. Approving needs the
 * scan's tier cleared (KOBE-312, SK32): Caution findings acknowledged, and a Block scan only by a
 * Site admin with a reason (audited `skill.scan.override`). Rejecting is always allowed.
 */
export function decideReview(
  db: KobeDb,
  teamId: string,
  at: { skillId: string; version: number },
  decision: Decision,
): Promise<DecideResult> {
  const key = and(
    eq(teamSkillReviews.teamId, teamId),
    eq(teamSkillReviews.skillId, at.skillId),
    eq(teamSkillReviews.version, at.version),
  );
  return withTeam(db, teamId, async (tx) => {
    const [current] = await tx.select().from(teamSkillReviews).where(key).for("update");
    if (!current) return { ok: false, error: "not_found" };
    if (current.status === decision.status) return { ok: false, error: "unchanged" };
    // A blocklisted bundle can still be rejected, never approved (KOBE-81).
    const blocked = await isBlocked(tx, current.contentHash);
    if (decision.status === "approved" && blocked) return { ok: false, error: "blocklisted" };
    const verdict = reviewVerdict(current);
    const digest = findingsDigest(current);
    if (decision.status === "approved") {
      const refused = approvalRefusal(current, verdict, digest, decision);
      if (refused) return { ok: false, error: refused };
    }
    if (decision.status === "approved" && verdict === "block") {
      await recordAudit(tx, {
        action: "skill.scan.override",
        teamId,
        target: {
          skillId: at.skillId,
          slug: current.slug,
          version: at.version,
          bundleHash: current.contentHash,
          findings: current.findings.filter((f) => f.severity === "block").length,
          rules: [
            ...new Set(current.findings.filter((f) => f.severity === "block").map((f) => f.rule)),
          ].sort(),
          // The reason is the review note, which a later decision overwrites; its hash here
          // keeps the override's reason tamper-evident (review S6).
          reasonSha256: sha256(decision.note ?? ""),
        },
      });
    }
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
        verdict,
        ...(decision.status === "approved" && verdict !== "pass"
          ? { acknowledged: true as const, findingsSha256: digest }
          : {}),
      },
    });
    const semvers = await semversOf(tx, teamId, [current]);
    const review: ReviewRecord = {
      ...current,
      semver: semvers.get(`${current.skillId}:${current.version}`) ?? legacySemver(current.version),
      status: decision.status,
      reviewedBy: decision.reviewerId,
      reviewedAt,
      reviewNote: decision.note,
      blocked,
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
  const rows = await tx
    .select({
      slug: teamSkillReviews.slug,
      hash: teamSkillReviews.contentHash,
    })
    .from(teamSkillReviews)
    .where(
      and(
        eq(teamSkillReviews.teamId, teamId),
        eq(teamSkillReviews.scope, "team"),
        eq(teamSkillReviews.status, "approved"),
        inArray(teamSkillReviews.slug, [...names]),
      ),
    )
    .orderBy(desc(teamSkillReviews.version));
  const newest = new Map<string, string>();
  for (const r of rows) if (!newest.has(r.slug)) newest.set(r.slug, r.hash);
  return [...newest].map(([name, hash]) => ({ name, hash }));
}

/**
 * The user's personal skills (latest versions) that may run in this team: unflagged scanned ones,
 * and flagged or unscanned ones this team's admin approved. With `ensureRows`, a version that is
 * blocked gets a pending review row here so the team's admins can see and decide it.
 */
export async function usablePersonalSkills(
  tx: KobeTx,
  args: { teamId: string; userId: string; ensureRows: boolean },
): Promise<{ name: string; hash: string }[]> {
  return (await personalSkillUsage(tx, args)).usable;
}

/** Like `usablePersonalSkills`, plus the names blocked for lack of this team's approval. */
export async function personalSkillUsage(
  tx: KobeTx,
  args: { teamId: string; userId: string; ensureRows: boolean },
): Promise<{ usable: { name: string; hash: string }[]; blocked: string[] }> {
  const rows = await tx
    .select({
      skillId: personalSkills.id,
      name: personalSkills.slug,
      version: personalSkillVersions.version,
      hash: personalSkillVersions.contentHash,
      scan: {
        flagged: personalSkillScans.flagged,
        findings: personalSkillScans.findings,
        scripts: personalSkillScans.scripts,
        skipped: personalSkillScans.skipped,
      },
    })
    .from(personalSkills)
    .innerJoin(
      personalSkillVersions,
      and(
        eq(personalSkillVersions.skillId, personalSkills.id),
        eq(personalSkillVersions.version, personalSkills.latestVersion),
      ),
    )
    .leftJoin(
      personalSkillScans,
      and(
        eq(personalSkillScans.skillId, personalSkillVersions.skillId),
        eq(personalSkillScans.version, personalSkillVersions.version),
      ),
    )
    .where(eq(personalSkills.ownerUserId, args.userId));
  // Needs this team's approval: never scanned, or a scan that is not Pass (stored before KOBE-312
  // too: a skipped binary with no finding reads as Caution, review S5).
  const needs = (r: (typeof rows)[number]) =>
    r.scan === null || r.scan.flagged || storedVerdict(r.scan) !== "pass";
  const needsApproval = rows.filter(needs);
  if (needsApproval.length === 0) {
    return { usable: rows.map(({ name, hash }) => ({ name, hash })), blocked: [] };
  }
  const decided = await tx
    .select({
      skillId: teamSkillReviews.skillId,
      version: teamSkillReviews.version,
      status: teamSkillReviews.status,
    })
    .from(teamSkillReviews)
    .where(
      and(
        eq(teamSkillReviews.teamId, args.teamId),
        inArray(
          teamSkillReviews.skillId,
          needsApproval.map((r) => r.skillId),
        ),
      ),
    );
  const status = new Map(decided.map((d) => [`${d.skillId}:${d.version}`, d.status]));
  if (args.ensureRows) {
    const missing = needsApproval.filter((r) => !status.has(`${r.skillId}:${r.version}`));
    if (missing.length > 0) {
      await tx
        .insert(teamSkillReviews)
        .values(
          missing.map((r) => ({
            teamId: args.teamId,
            skillId: r.skillId,
            version: r.version,
            scope: "personal" as const,
            slug: r.name,
            contentHash: r.hash,
            unscanned: r.scan === null,
            flagged: r.scan !== null && needs(r),
            findings: r.scan?.findings ?? [],
            scripts: r.scan?.scripts ?? [],
            skipped: r.scan?.skipped ?? [],
          })),
        )
        .onConflictDoNothing();
    }
  }
  const isUsable = (r: (typeof rows)[number]) =>
    !needs(r) || status.get(`${r.skillId}:${r.version}`) === "approved";
  return {
    usable: rows.filter(isUsable).map(({ name, hash }) => ({ name, hash })),
    blocked: rows.filter((r) => !isUsable(r)).map((r) => r.name),
  };
}

async function readBytes(blobs: BlobStore, key: string): Promise<Uint8Array | null> {
  const object = await blobs.objects.get(key);
  if (!object) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of object.body) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

/**
 * Scans review rows still marked unscanned (backfilled versions, or personal versions that
 * predate scanning), a batch per call, filling in their findings. It scans the whole package
 * (evals and manifest too) where one is stored, as the upload does. A row whose bundle can't be
 * read or scanned stays unscanned and is retried on the next listing.
 */
export async function scanUnscanned(db: KobeDb, blobs: BlobStore, teamId: string): Promise<void> {
  const todo = await withTeam(db, teamId, async (tx) => {
    const rows = await tx
      .select({
        skillId: teamSkillReviews.skillId,
        version: teamSkillReviews.version,
        scope: teamSkillReviews.scope,
      })
      .from(teamSkillReviews)
      .where(and(eq(teamSkillReviews.teamId, teamId), eq(teamSkillReviews.unscanned, true)))
      .limit(SCAN_BATCH);
    return Promise.all(
      rows.map(async (r) => {
        const [v] =
          r.scope === "team"
            ? await tx
                .select({
                  key: sql<string>`coalesce(${teamSkillVersions.packageStorageKey}, ${teamSkillVersions.storageKey})`,
                })
                .from(teamSkillVersions)
                .where(
                  and(
                    eq(teamSkillVersions.teamId, teamId),
                    eq(teamSkillVersions.skillId, r.skillId),
                    eq(teamSkillVersions.version, r.version),
                  ),
                )
            : await tx
                .select({
                  key: sql<string>`coalesce(${personalSkillVersions.packageStorageKey}, ${personalSkillVersions.storageKey})`,
                })
                .from(personalSkillVersions)
                .where(
                  and(
                    eq(personalSkillVersions.skillId, r.skillId),
                    eq(personalSkillVersions.version, r.version),
                  ),
                );
        return { ...r, key: v?.key };
      }),
    );
  });
  for (const row of todo) {
    if (!row.key) continue;
    try {
      const bytes = await readBytes(blobs, row.key);
      if (!bytes) continue;
      const scan = storedScan(scanCanonicalZip(bytes));
      await withTeam(db, teamId, (tx) =>
        tx
          .update(teamSkillReviews)
          .set({ ...scan, unscanned: false, scannedAt: new Date() })
          .where(
            and(
              eq(teamSkillReviews.teamId, teamId),
              eq(teamSkillReviews.skillId, row.skillId),
              eq(teamSkillReviews.version, row.version),
              eq(teamSkillReviews.unscanned, true),
            ),
          ),
      );
    } catch (err) {
      logger.error({ err, skillId: row.skillId, version: row.version }, "skills: late scan failed");
    }
  }
}
