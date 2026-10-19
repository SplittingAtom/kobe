import { sql, type KobeDb, type KobeTx } from "@kobe/db";
import type { BlobStore } from "../../retention/blobs.js";
import { parseSemver } from "../semver.js";
import {
  changedFileCount,
  diffPackages,
  readPackage,
  type PackageDiff,
  type StoredPackage,
} from "./review-diff.js";

/**
 * The Registry queue (KOBE-334, SK23): what reviewers see. Site-wide records only: the Registry
 * holds packages and numbers, never team content, and `source` (the submitting team's ids) is
 * shown to reviewers only. Each item carries its semver bump and changed-file count against the
 * skill's currently approved version, so small changes can be batched.
 */

type Db = KobeDb | KobeTx;

export const QUEUE_FILTERS = [
  "open",
  "submitted",
  "in_review",
  "changes_requested",
  "approved",
  "rejected",
  "all",
] as const;
export type QueueFilter = (typeof QUEUE_FILTERS)[number];

const FILTER_STATES: Readonly<Record<QueueFilter, readonly string[] | null>> = {
  open: ["submitted", "in_review"],
  submitted: ["submitted"],
  in_review: ["in_review"],
  changes_requested: ["changes_requested"],
  approved: ["approved"],
  rejected: ["rejected"],
  all: null,
};

const QUEUE_LIMIT = 100;

export type Bump = "new" | "major" | "minor" | "patch" | "older";

export interface Person {
  readonly id: string;
  readonly name: string;
}

/** A Registry version row as the review reads it. */
export interface VersionRow extends StoredPackage {
  readonly id: string;
  readonly skillId: string;
  readonly name: string;
  readonly skillStatus: string;
  readonly publisher: string;
  readonly semver: string;
  readonly seq: number;
  readonly state: string;
  readonly verdict: string;
  readonly manifest: Record<string, unknown>;
  readonly provenance: Record<string, unknown>;
  readonly source: Record<string, unknown>;
  readonly scan: Record<string, unknown>;
  readonly scorecard: Record<string, unknown> | null;
  readonly authoritativeScorecard: Record<string, unknown> | null;
  readonly submittedBy: string | null;
  readonly submittedAt: Date;
  readonly claimedBy: string | null;
  readonly claimedAt: Date | null;
  readonly reviewedBy: string | null;
  readonly approvedAt: Date | null;
  readonly selfApproved: boolean;
}

const VERSION_COLUMNS = sql`
  v.id, v.skill_id AS "skillId", s.name, s.status AS "skillStatus", v.publisher, v.semver, v.seq,
  v.state, v.verdict, v.manifest, v.provenance, v.source, v.scan, v.scorecard,
  v.authoritative_scorecard AS "authoritativeScorecard", v.package_hash AS "packageHash",
  v.package_storage_key AS "packageStorageKey", v.runtime_hash AS "runtimeHash",
  v.runtime_storage_key AS "runtimeStorageKey", v.runtime_size_bytes AS "runtimeSizeBytes",
  v.submitted_by AS "submittedBy", v.submitted_at AS "submittedAt", v.claimed_by AS "claimedBy",
  v.claimed_at AS "claimedAt", v.reviewed_by AS "reviewedBy", v.approved_at AS "approvedAt",
  v.self_approved AS "selfApproved"`;

/** One version; `lock` holds it `FOR UPDATE` (a decision on it). */
export async function versionRow(
  db: Db,
  id: string,
  lock = false,
): Promise<VersionRow | undefined> {
  const res = await db.execute<VersionRow & Record<string, unknown>>(sql`
    SELECT ${VERSION_COLUMNS} FROM registry_versions v JOIN registry_skills s ON s.id = v.skill_id
     WHERE v.id = ${id} ${lock ? sql`FOR UPDATE OF v` : sql``}`);
  return res.rows[0];
}

/** The skill's currently approved version (the newest by seq), other than `exceptId`. */
export async function approvedVersion(
  db: Db,
  skillId: string,
  exceptId: string,
): Promise<VersionRow | undefined> {
  const res = await db.execute<VersionRow & Record<string, unknown>>(sql`
    SELECT ${VERSION_COLUMNS} FROM registry_versions v JOIN registry_skills s ON s.id = v.skill_id
     WHERE v.skill_id = ${skillId} AND v.id <> ${exceptId} AND v.state = 'approved'
       AND v.suspended_at IS NULL
     ORDER BY v.seq DESC LIMIT 1`);
  return res.rows[0];
}

export function bumpOf(previous: string | null, next: string): Bump {
  if (previous === null) return "new";
  const a = parseSemver(previous);
  const b = parseSemver(next);
  if (!a || !b) return "patch";
  if (b.major !== a.major) return b.major > a.major ? "major" : "older";
  if (b.minor !== a.minor) return b.minor > a.minor ? "minor" : "older";
  return b.patch > a.patch ? "patch" : "older";
}

/** Changed-file counts by (approved package, submitted package): packages never change. */
const changedCache = new Map<string, number>();
const CACHE_MAX = 1000;

/** The diff of `version` against the approved version (null: the bytes aren't stored). */
export async function versionDiff(
  blobs: BlobStore,
  version: StoredPackage,
  approved: StoredPackage | undefined,
): Promise<PackageDiff | null> {
  const after = await readPackage(blobs, version);
  if (!after) return null;
  const before = approved ? await readPackage(blobs, approved) : null;
  return diffPackages(before, after);
}

/** Bytes compared per file only (review H1): the queue never computes a line diff. */
async function changedFiles(
  blobs: BlobStore,
  version: StoredPackage,
  approved: StoredPackage | undefined,
): Promise<number | null> {
  const key = `${approved?.packageHash ?? "-"}:${version.packageHash}`;
  const cached = changedCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const after = await readPackage(blobs, version);
    if (!after) return null;
    const before = approved ? await readPackage(blobs, approved) : null;
    const count = changedFileCount(before, after);
    if (changedCache.size >= CACHE_MAX) changedCache.clear();
    changedCache.set(key, count);
    return count;
  } catch {
    return null;
  }
}

async function names(db: Db, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((i): i is string => i !== null))];
  if (wanted.length === 0) return new Map();
  const res = await db.execute<{ id: string; name: string }>(sql`
    SELECT id, name FROM users WHERE id IN (${sql.join(
      wanted.map((i) => sql`${i}`),
      sql`, `,
    )})`);
  return new Map(res.rows.map((r) => [r.id, r.name]));
}

export const personOf = (who: Map<string, string>, id: string | null): Person | null =>
  id ? { id, name: who.get(id) ?? "Unknown user" } : null;

export interface QueueItem {
  readonly id: string;
  readonly skill: { readonly id: string; readonly name: string };
  readonly semver: string;
  readonly previous: { readonly id: string; readonly semver: string } | null;
  readonly bump: Bump;
  readonly changedFiles: number | null;
  readonly state: string;
  readonly verdict: string;
  readonly submittedBy: Person | null;
  readonly submittedAt: string;
  readonly claimedBy: Person | null;
  readonly authoritativeScorecard: boolean;
}

/** The queue, oldest submission first; maintainer submissions only (Kobe publishes unreviewed). */
export async function listQueue(
  db: KobeDb,
  blobs: BlobStore,
  filter: QueueFilter,
): Promise<QueueItem[]> {
  const states = FILTER_STATES[filter];
  const res = await db.execute<VersionRow & Record<string, unknown>>(sql`
    SELECT ${VERSION_COLUMNS} FROM registry_versions v JOIN registry_skills s ON s.id = v.skill_id
     WHERE v.publisher = 'maintainer'
       ${
         states
           ? sql`AND v.state::text IN (${sql.join(
               states.map((st) => sql`${st}`),
               sql`, `,
             )})`
           : sql``
       }
     ORDER BY v.submitted_at, v.id LIMIT ${QUEUE_LIMIT}`);
  const who = await names(
    db,
    res.rows.flatMap((r) => [r.submittedBy, r.claimedBy]),
  );
  const items: QueueItem[] = [];
  for (const v of res.rows) {
    const approved = await approvedVersion(db, v.skillId, v.id);
    items.push({
      id: v.id,
      skill: { id: v.skillId, name: v.name },
      semver: v.semver,
      previous: approved ? { id: approved.id, semver: approved.semver } : null,
      bump: bumpOf(approved?.semver ?? null, v.semver),
      changedFiles: await changedFiles(blobs, v, approved),
      state: v.state,
      verdict: v.verdict,
      submittedBy: personOf(who, v.submittedBy),
      submittedAt: new Date(v.submittedAt).toISOString(),
      claimedBy: personOf(who, v.claimedBy),
      authoritativeScorecard: v.authoritativeScorecard !== null,
    });
  }
  return items;
}

export interface ReviewEvent {
  readonly action: string;
  readonly actor: Person | null;
  readonly note: string | null;
  readonly checklist: Record<string, unknown> | null;
  readonly at: string;
}

/** The version's review history, oldest first. */
export async function reviewEvents(db: Db, versionId: string): Promise<ReviewEvent[]> {
  const res = await db.execute<{
    action: string;
    actor_id: string;
    actor_name: string;
    note: string | null;
    checklist: Record<string, unknown> | null;
    at: Date;
  }>(sql`
    SELECT e.action, e.actor_id, u.name AS actor_name, e.note, e.checklist, e.at
      FROM registry_review_events e JOIN users u ON u.id = e.actor_id
     WHERE e.version_id = ${versionId} ORDER BY e.at, e.id`);
  return res.rows.map((r) => ({
    action: r.action,
    actor: { id: r.actor_id, name: r.actor_name },
    note: r.note,
    checklist: r.checklist,
    at: new Date(r.at).toISOString(),
  }));
}

export { names as userNames };
