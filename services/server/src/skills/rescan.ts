import { RULE_SET_VERSION, storedVerdict, type ScanResult } from "@kobe/skill-scanner";
import {
  RESCAN_SUSPENDED_MAX,
  SYSTEM_ACTOR,
  and,
  asc,
  eq,
  personalSkillScans,
  personalSkills,
  personalSkillVersions,
  skillRescanRuns,
  sql,
  teamSkillReviews,
  teamSkillVersions,
  teams,
  withTeam,
  type KobeDatabase,
  type KobeDb,
  type RescanSuspension,
  type StoredFinding,
} from "@kobe/db";
import type { Logger } from "pino";
import { recordAudit } from "../audit/record.js";
import type { Mailer } from "../mail/mailer.js";
import type { BlobStore } from "../retention/blobs.js";
import { readVerified } from "./blob-read.js";
import { notifySuspensions, type SuspendedVersion } from "./rescan-notify.js";
import { scanCanonicalZip, storedScan } from "./review.js";

/**
 * Rescans on a scanner rule-set change (KOBE-313, spec SK32). Every stored scan records its rule
 * set; one whose rule set is not the current one (null: before KOBE-313) is redone from the stored
 * bundle: personal versions' own scans, then every team's review rows (team versions, and personal
 * versions reviewed in that team). Catalog versions have no stored bundle yet (their submission
 * flow comes with the Registry review); `registry_versions.suspended_at` is ready for them.
 *
 * One rescan per rule set across replicas: a session advisory lock (the lease) and a
 * `skill_rescan_runs` row per rule set, which holds progress and the result for the Site console.
 * A version a rescan newly turns Block is suspended: an approved review row goes back to `pending`
 * with `suspended_at` (runs omit the skill as `suspended` until it is decided again), a personal
 * version that ran unreviewed (Pass) gets `suspended_at` on its scan (it now needs each team's
 * approval). Each suspension is audited, and its author and team admins are emailed.
 */
const RESCAN_LOCK = "kobe.skills.rescan";
const BATCH = 50;

export interface RescanDeps {
  readonly database: KobeDatabase;
  readonly blobs: BlobStore;
  readonly log: Pick<Logger, "info" | "warn" | "error">;
  readonly mailer?: Mailer;
  readonly publicUrl?: string;
  /** The rule set to rescan to (tests); defaults to the scanner's. */
  readonly ruleSetVersion?: string;
}

export interface RescanReport {
  readonly ruleSetVersion: string;
  /** False when this rule set's rescan was already done (nothing to do). */
  readonly ran: boolean;
  readonly scanned: number;
  readonly changed: number;
  readonly suspended: number;
  readonly failed: number;
}

/** What one pass did; written to the run row after every batch. */
interface Pass {
  scanned: number;
  changed: number;
  failed: number;
  readonly suspended: SuspendedVersion[];
}

interface StoredBundle {
  readonly storageKey: string;
  readonly packageStorageKey: string | null;
  readonly contentHash: string;
  readonly packageHash: string | null;
  readonly sizeBytes: number;
}

/** Scans a stored version's whole package (or its runtime zip), verified; null if unreadable. */
async function scanStored(
  blobs: BlobStore,
  v: StoredBundle,
  cache: Map<string, ScanResult | null>,
): Promise<ScanResult | null> {
  const key = v.packageStorageKey ?? v.storageKey;
  if (cache.has(key)) return cache.get(key) ?? null;
  const bytes =
    v.packageStorageKey && v.packageHash
      ? await readVerified(blobs, v.packageStorageKey, v.packageHash, null)
      : await readVerified(blobs, v.storageKey, v.contentHash, v.sizeBytes);
  const result = bytes ? scanCanonicalZip(bytes) : null;
  cache.set(key, result);
  return result;
}

const stale = (
  column: typeof teamSkillReviews.ruleSetVersion | typeof personalSkillScans.ruleSetVersion,
  v: string,
) => sql`${column} IS DISTINCT FROM ${v}`;

const bundleColumns = (t: typeof teamSkillVersions | typeof personalSkillVersions) => ({
  storageKey: t.storageKey,
  packageStorageKey: t.packageStorageKey,
  contentHash: t.contentHash,
  packageHash: t.packageHash,
  sizeBytes: t.sizeBytes,
});

/** Personal versions' own scans (site-wide). */
async function rescanPersonal(
  deps: RescanDeps,
  v: string,
  pass: Pass,
  cache: Map<string, ScanResult | null>,
) {
  const db = deps.database.db;
  let after: { skillId: string; version: number } | undefined;
  for (;;) {
    const rows = await db
      .select({
        skillId: personalSkillScans.skillId,
        version: personalSkillScans.version,
        findings: personalSkillScans.findings,
        skipped: personalSkillScans.skipped,
        slug: personalSkills.slug,
        ownerId: personalSkills.ownerUserId,
        ...bundleColumns(personalSkillVersions),
      })
      .from(personalSkillScans)
      .innerJoin(
        personalSkillVersions,
        and(
          eq(personalSkillVersions.skillId, personalSkillScans.skillId),
          eq(personalSkillVersions.version, personalSkillScans.version),
        ),
      )
      .innerJoin(personalSkills, eq(personalSkills.id, personalSkillScans.skillId))
      .where(
        and(
          stale(personalSkillScans.ruleSetVersion, v),
          after
            ? sql`(${personalSkillScans.skillId}, ${personalSkillScans.version}) > (${after.skillId}::uuid, ${after.version})`
            : undefined,
        ),
      )
      .orderBy(asc(personalSkillScans.skillId), asc(personalSkillScans.version))
      .limit(BATCH);
    if (rows.length === 0) return;
    for (const row of rows) {
      const scan = await scanStored(deps.blobs, row, cache).catch(() => null);
      if (!scan) {
        pass.failed += 1;
        continue;
      }
      const before = storedVerdict(row);
      // A Pass version ran in every team without review: Block now needs each team's approval.
      const suspend = before === "pass" && scan.verdict === "block";
      await db.transaction(async (tx) => {
        const updated = await tx
          .update(personalSkillScans)
          .set({
            ...storedScan(scan),
            ruleSetVersion: v,
            scannedAt: new Date(),
            ...(suspend ? { suspendedAt: new Date() } : {}),
          })
          .where(
            and(
              eq(personalSkillScans.skillId, row.skillId),
              eq(personalSkillScans.version, row.version),
              stale(personalSkillScans.ruleSetVersion, v),
            ),
          )
          .returning({ skillId: personalSkillScans.skillId });
        if (updated.length === 0) return;
        pass.scanned += 1;
        if (before !== scan.verdict) pass.changed += 1;
        if (!suspend) return;
        const at = { skillId: row.skillId, slug: row.slug, version: row.version };
        await recordAudit(tx, {
          action: "skill.rescan.suspended",
          actor: SYSTEM_ACTOR,
          target: { ...at, scope: "personal", ruleSetVersion: v },
        });
        pass.suspended.push({ ...at, scope: "personal", authorId: row.ownerId });
      });
    }
    const last = rows.at(-1);
    after = last ? { skillId: last.skillId, version: last.version } : undefined;
  }
}

interface ReviewRow {
  readonly skillId: string;
  readonly version: number;
  readonly scope: "team" | "personal";
  readonly slug: string;
  readonly status: string;
  readonly findings: StoredFinding[];
  readonly skipped: string[];
}

/** The bundle and author of one review row's version (team table inside `withTeam`). */
async function versionOf(db: KobeDb, teamId: string, row: ReviewRow) {
  if (row.scope === "team") {
    const [v] = await withTeam(db, teamId, (tx) =>
      tx
        .select({ ...bundleColumns(teamSkillVersions), authorId: teamSkillVersions.uploadedBy })
        .from(teamSkillVersions)
        .where(
          and(
            eq(teamSkillVersions.teamId, teamId),
            eq(teamSkillVersions.skillId, row.skillId),
            eq(teamSkillVersions.version, row.version),
          ),
        ),
    );
    return v;
  }
  const [v] = await db
    .select({ ...bundleColumns(personalSkillVersions), authorId: personalSkills.ownerUserId })
    .from(personalSkillVersions)
    .innerJoin(personalSkills, eq(personalSkills.id, personalSkillVersions.skillId))
    .where(
      and(
        eq(personalSkillVersions.skillId, row.skillId),
        eq(personalSkillVersions.version, row.version),
      ),
    );
  return v;
}

/** One team's review rows, under its RLS. */
async function rescanTeam(
  deps: RescanDeps,
  v: string,
  teamId: string,
  pass: Pass,
  cache: Map<string, ScanResult | null>,
) {
  const db = deps.database.db;
  const key = (r: { skillId: string; version: number }) =>
    and(
      eq(teamSkillReviews.teamId, teamId),
      eq(teamSkillReviews.skillId, r.skillId),
      eq(teamSkillReviews.version, r.version),
    );
  let after: { skillId: string; version: number } | undefined;
  for (;;) {
    const rows: ReviewRow[] = await withTeam(db, teamId, (tx) =>
      tx
        .select({
          skillId: teamSkillReviews.skillId,
          version: teamSkillReviews.version,
          scope: teamSkillReviews.scope,
          slug: teamSkillReviews.slug,
          status: teamSkillReviews.status,
          findings: teamSkillReviews.findings,
          skipped: teamSkillReviews.skipped,
        })
        .from(teamSkillReviews)
        .where(
          and(
            eq(teamSkillReviews.teamId, teamId),
            eq(teamSkillReviews.unscanned, false),
            stale(teamSkillReviews.ruleSetVersion, v),
            after
              ? sql`(${teamSkillReviews.skillId}, ${teamSkillReviews.version}) > (${after.skillId}::uuid, ${after.version})`
              : undefined,
          ),
        )
        .orderBy(asc(teamSkillReviews.skillId), asc(teamSkillReviews.version))
        .limit(BATCH),
    );
    if (rows.length === 0) return;
    for (const row of rows) {
      const version = await versionOf(db, teamId, row);
      const scan = version ? await scanStored(deps.blobs, version, cache).catch(() => null) : null;
      if (!version || !scan) {
        pass.failed += 1;
        continue;
      }
      const before = storedVerdict(row);
      const suspend = row.status === "approved" && scan.verdict === "block" && before !== "block";
      await withTeam(db, teamId, async (tx) => {
        const updated = await tx
          .update(teamSkillReviews)
          .set({
            ...storedScan(scan),
            ruleSetVersion: v,
            scannedAt: new Date(),
            ...(suspend
              ? {
                  status: "pending" as const,
                  reviewedBy: null,
                  reviewedAt: null,
                  suspendedAt: new Date(),
                }
              : {}),
          })
          .where(
            and(
              key(row),
              stale(teamSkillReviews.ruleSetVersion, v),
              sql`${teamSkillReviews.status} = ${row.status}`,
            ),
          )
          .returning({ skillId: teamSkillReviews.skillId });
        if (updated.length === 0) return;
        pass.scanned += 1;
        if (before !== scan.verdict) pass.changed += 1;
        if (!suspend) return;
        const at = { skillId: row.skillId, slug: row.slug, version: row.version };
        await recordAudit(tx, {
          action: "skill.rescan.suspended",
          actor: SYSTEM_ACTOR,
          teamId,
          target: { ...at, scope: row.scope, ruleSetVersion: v },
        });
        pass.suspended.push({ ...at, scope: row.scope, teamId, authorId: version.authorId });
      });
    }
    const last = rows.at(-1);
    after = last ? { skillId: last.skillId, version: last.version } : undefined;
  }
}

/** The run row of this rule set: created, or reopened when an earlier pass left failures. */
async function openRun(db: KobeDb, v: string) {
  await db.insert(skillRescanRuns).values({ ruleSetVersion: v }).onConflictDoNothing();
  const [run] = await db
    .select()
    .from(skillRescanRuns)
    .where(eq(skillRescanRuns.ruleSetVersion, v));
  if (!run) throw new Error("skills: rescan run row missing");
  if (run.status === "done") return run;
  await db
    .update(skillRescanRuns)
    .set({ status: "running", finishedAt: null, failed: 0 })
    .where(eq(skillRescanRuns.id, run.id));
  return { ...run, status: "running" as const, failed: 0 };
}

const suspensionOf = (s: SuspendedVersion): RescanSuspension => ({
  scope: s.scope,
  ...(s.teamId ? { teamId: s.teamId } : {}),
  skillId: s.skillId,
  version: s.version,
  slug: s.slug,
});

/** One full pass for the rule set, when no other replica holds the lease. */
async function runPass(deps: RescanDeps, v: string): Promise<RescanReport> {
  const db = deps.database.db;
  const run = await openRun(db, v);
  if (run.status === "done") {
    const { scanned, changed, suspended, failed } = run;
    return { ruleSetVersion: v, ran: false, scanned, changed, suspended, failed };
  }
  const pass: Pass = { scanned: 0, changed: 0, failed: 0, suspended: [] };
  const cache = new Map<string, ScanResult | null>();
  await rescanPersonal(deps, v, pass, cache);
  for (const team of await db.select({ id: teams.id }).from(teams)) {
    await rescanTeam(deps, v, team.id, pass, cache);
  }
  const suspensions = [...(run.suspensions ?? []), ...pass.suspended.map(suspensionOf)].slice(
    0,
    RESCAN_SUSPENDED_MAX,
  );
  const [done] = await db
    .update(skillRescanRuns)
    .set({
      status: pass.failed > 0 ? "failed" : "done",
      finishedAt: new Date(),
      scanned: sql`${skillRescanRuns.scanned} + ${pass.scanned}`,
      changed: sql`${skillRescanRuns.changed} + ${pass.changed}`,
      suspended: sql`${skillRescanRuns.suspended} + ${pass.suspended.length}`,
      failed: pass.failed,
      suspensions,
    })
    .where(eq(skillRescanRuns.id, run.id))
    .returning();
  deps.log.info(
    {
      ruleSetVersion: v,
      scanned: pass.scanned,
      suspended: pass.suspended.length,
      failed: pass.failed,
    },
    "skills: rescan pass finished",
  );
  if (deps.mailer && deps.publicUrl)
    await notifySuspensions({ db, mailer: deps.mailer, publicUrl: deps.publicUrl }, pass.suspended);
  return {
    ruleSetVersion: v,
    ran: true,
    scanned: done?.scanned ?? pass.scanned,
    changed: done?.changed ?? pass.changed,
    suspended: done?.suspended ?? pass.suspended.length,
    failed: pass.failed,
  };
}

/**
 * The rescan for the current rule set, on this replica if no other holds the lease (a session
 * advisory lock on a dedicated connection). Null when another replica holds it.
 */
export async function rescanOnce(deps: RescanDeps): Promise<RescanReport | null> {
  const v = deps.ruleSetVersion ?? RULE_SET_VERSION;
  const client = await deps.database.pool.connect();
  let destroy = false;
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked`,
      [RESCAN_LOCK],
    );
    if (!rows[0]?.locked) return null;
    try {
      return await runPass(deps, v);
    } finally {
      await client
        .query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [RESCAN_LOCK])
        .catch((err: unknown) => {
          deps.log.warn({ err }, "skills: rescan unlock failed; dropping the connection");
          destroy = true;
        });
    }
  } finally {
    client.release(destroy);
  }
}

/** How often each server checks whether the current rule set's rescan is done (cheap once it is). */
export const RESCAN_EVERY_MS = 10 * 60_000;

/** Runs {@link rescanOnce} now and every {@link RESCAN_EVERY_MS}; returns a stop function. */
export function startSkillRescan(deps: RescanDeps & { readonly everyMs?: number }): () => void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    rescanOnce(deps)
      .catch((err: unknown) => deps.log.error({ err }, "skills: rescan failed"))
      .finally(() => {
        running = false;
      });
  };
  tick();
  const timer = setInterval(tick, deps.everyMs ?? RESCAN_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
