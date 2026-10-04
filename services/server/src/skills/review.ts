import { unzipSync } from "fflate";
import { z } from "zod";
import { scanSkillBundle, type ScanResult } from "@kobe/skill-scanner";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  sql,
  installSkillScans,
  installSkills,
  installSkillVersions,
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
  flagged: scan.findings.length > 0,
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
  await tx.insert(installSkillScans).values({ ...at, ...storedScan(scan) });
}

export interface ReviewRecord {
  readonly skillId: string;
  readonly slug: string;
  readonly version: number;
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
}

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
    const rows = await tx
      .select()
      .from(teamSkillReviews)
      .where(
        and(
          eq(teamSkillReviews.teamId, teamId),
          inArray(teamSkillReviews.skillId, [...new Set(pageKeys.map((k) => k.skillId))]),
        ),
      );
    const byKey = new Map(rows.map((r) => [`${r.skillId}:${r.version}`, r]));
    return {
      reviews: pageKeys.flatMap((k) => byKey.get(`${k.skillId}:${k.version}`) ?? []),
      nextCursor,
    };
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
    const [current] = await tx.select().from(teamSkillReviews).where(key).for("update");
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
  const rows = await tx
    .select({
      skillId: installSkills.id,
      name: installSkills.slug,
      version: installSkillVersions.version,
      hash: installSkillVersions.contentHash,
      scan: {
        flagged: installSkillScans.flagged,
        findings: installSkillScans.findings,
        scripts: installSkillScans.scripts,
        skipped: installSkillScans.skipped,
      },
    })
    .from(installSkills)
    .innerJoin(
      installSkillVersions,
      and(
        eq(installSkillVersions.skillId, installSkills.id),
        eq(installSkillVersions.version, installSkills.latestVersion),
      ),
    )
    .leftJoin(
      installSkillScans,
      and(
        eq(installSkillScans.skillId, installSkillVersions.skillId),
        eq(installSkillScans.version, installSkillVersions.version),
      ),
    )
    .where(eq(installSkills.ownerUserId, args.userId));
  const needsApproval = rows.filter((r) => r.scan === null || r.scan.flagged);
  if (needsApproval.length === 0) return rows.map(({ name, hash }) => ({ name, hash }));
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
            flagged: r.scan?.flagged ?? false,
            findings: r.scan?.findings ?? [],
            scripts: r.scan?.scripts ?? [],
            skipped: r.scan?.skipped ?? [],
          })),
        )
        .onConflictDoNothing();
    }
  }
  return rows
    .filter((r) => {
      const needs = r.scan === null || r.scan.flagged;
      return !needs || status.get(`${r.skillId}:${r.version}`) === "approved";
    })
    .map(({ name, hash }) => ({ name, hash }));
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
 * predate scanning), a batch per call, filling in their findings. A row whose bundle can't be
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
                .select({ key: teamSkillVersions.storageKey })
                .from(teamSkillVersions)
                .where(
                  and(
                    eq(teamSkillVersions.teamId, teamId),
                    eq(teamSkillVersions.skillId, r.skillId),
                    eq(teamSkillVersions.version, r.version),
                  ),
                )
            : await tx
                .select({ key: installSkillVersions.storageKey })
                .from(installSkillVersions)
                .where(
                  and(
                    eq(installSkillVersions.skillId, r.skillId),
                    eq(installSkillVersions.version, r.version),
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
