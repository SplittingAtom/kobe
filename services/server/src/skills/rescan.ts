import { RULE_SET, RULE_SET_VERSION } from "@kobe/skill-scanner";
import {
  RESCAN_SUSPENDED_MAX,
  eq,
  gt,
  skillRescanRuns,
  sql,
  teams,
  type KobeDatabase,
  type KobeDb,
  type RescanSuspension,
} from "@kobe/db";
import type { Logger } from "pino";
import type { Mailer } from "../mail/mailer.js";
import type { BlobStore } from "../retention/blobs.js";
import { ScanCache } from "./rescan-cache.js";
import { sendPendingPersonal, sendPendingTeam, type SuspendedVersion } from "./rescan-notify.js";
import {
  anyStale,
  emptyTally,
  personalBatch,
  teamBatch,
  type RowContext,
  type Tally,
} from "./rescan-rows.js";

/**
 * Rescans on a scanner rule-set change (KOBE-313, spec SK32). Every stored scan records the rule
 * set's ordinal (`RULE_SET`); a scan under an older one (null: before KOBE-313) is redone from the
 * stored bundle: personal versions' own scans, then every team's review rows (team versions, and
 * personal versions reviewed in that team). Catalog versions have no stored bundle yet (KOBE-333).
 *
 * Lease: a session advisory lock on a dedicated connection, so one replica at a time. Each tick
 * runs a pass, even after the rule set's run is `done`: pods of the previous release keep writing
 * old-rule scans during a rolling deploy, and a pass with nothing to do costs one query per team.
 * A pod whose rule set is older than the newest recorded run does nothing, and rows only ever move
 * forward, so an old pod never rescans rows down. Progress (counts, suspensions) is written to the
 * `skill_rescan_runs` row after every batch, and suspension emails go out of the row outbox after
 * every batch, so a crash loses neither.
 *
 * A version a rescan newly turns Block is suspended: an approved review row goes back to `pending`
 * with `suspended_at` (runs omit the skill as `suspended` until it is decided again); a personal
 * version that ran unreviewed (Pass) gets `suspended_at` on its scan (it then needs each team's
 * approval). Each suspension is audited (`skill.rescan.suspended`).
 */
const RESCAN_LOCK = "kobe.skills.rescan";

export interface RescanDeps {
  readonly database: KobeDatabase;
  readonly blobs: BlobStore;
  readonly log: Pick<Logger, "info" | "warn" | "error">;
  readonly mailer?: Mailer;
  readonly publicUrl?: string;
  /** The rule set to rescan to (tests); defaults to the scanner's. */
  readonly ruleSet?: number;
  readonly ruleSetVersion?: string;
}

export interface RescanReport {
  readonly ruleSet: number;
  readonly ruleSetVersion: string;
  /** False when this pod's rule set is older than the newest recorded rescan (nothing done). */
  readonly ran: boolean;
  /** Scans redone by this pass. */
  readonly scanned: number;
  readonly suspended: number;
  readonly failed: number;
  readonly status: "running" | "done" | "failed";
}

const suspensionOf = (s: SuspendedVersion): RescanSuspension => ({
  scope: s.scope,
  ...(s.teamId ? { teamId: s.teamId } : {}),
  skillId: s.skillId,
  version: s.version,
  slug: s.slug,
});

/** The run row of this rule set (created on first use); null when a newer rule set has one. */
async function openRun(db: KobeDb, ruleSet: number, ruleSetVersion: string) {
  const [newer] = await db
    .select({ ruleSet: skillRescanRuns.ruleSet })
    .from(skillRescanRuns)
    .where(gt(skillRescanRuns.ruleSet, ruleSet))
    .limit(1);
  if (newer) return null;
  await db.insert(skillRescanRuns).values({ ruleSet, ruleSetVersion }).onConflictDoNothing();
  const [run] = await db.select().from(skillRescanRuns).where(eq(skillRescanRuns.ruleSet, ruleSet));
  if (!run) throw new Error("skills: rescan run row missing");
  return run;
}

/** Adds one batch's work to the run row (the console's progress); the run is `running` again. */
async function flush(db: KobeDb, runId: string, tally: Tally): Promise<void> {
  if (tally.scanned === 0 && tally.failed === 0 && tally.suspended.length === 0) return;
  const added = JSON.stringify(tally.suspended.map(suspensionOf));
  await db
    .update(skillRescanRuns)
    .set({
      status: "running",
      finishedAt: null,
      scanned: sql`${skillRescanRuns.scanned} + ${tally.scanned}`,
      changed: sql`${skillRescanRuns.changed} + ${tally.changed}`,
      suspended: sql`${skillRescanRuns.suspended} + ${tally.suspended.length}`,
      suspensions: sql`coalesce((SELECT jsonb_agg(e) FROM (
          SELECT e FROM jsonb_array_elements(${skillRescanRuns.suspensions} || ${added}::jsonb) e
          LIMIT ${RESCAN_SUSPENDED_MAX}) kept), '[]'::jsonb)`,
    })
    .where(eq(skillRescanRuns.id, runId));
}

/** One pass under the lease. */
async function runPass(
  deps: RescanDeps,
  ruleSet: number,
  ruleSetVersion: string,
): Promise<RescanReport> {
  const db = deps.database.db;
  const run = await openRun(db, ruleSet, ruleSetVersion);
  if (!run) {
    deps.log.warn({ ruleSet }, "skills: a newer scanner rule set has rescanned; this pod skips");
    return {
      ruleSet,
      ruleSetVersion,
      ran: false,
      scanned: 0,
      suspended: 0,
      failed: 0,
      status: "done",
    };
  }
  const ctx: RowContext = {
    db,
    blobs: deps.blobs,
    log: deps.log,
    ruleSet,
    ruleSetVersion,
    cache: new ScanCache(),
  };
  const notify =
    deps.mailer && deps.publicUrl ? { db, mailer: deps.mailer, publicUrl: deps.publicUrl } : null;
  const totals = { scanned: 0, suspended: 0, failed: 0 };
  const batchDone = async (tally: Tally, teamId?: string) => {
    await flush(db, run.id, tally);
    totals.scanned += tally.scanned;
    totals.suspended += tally.suspended.length;
    totals.failed += tally.failed;
    if (notify) await (teamId ? sendPendingTeam(notify, teamId) : sendPendingPersonal(notify));
  };

  let after: { skillId: string; version: number } | undefined;
  do {
    const tally = emptyTally();
    after = await personalBatch(ctx, tally, after);
    await batchDone(tally);
  } while (after);
  const teamIds = (await db.select({ id: teams.id }).from(teams)).map((t) => t.id);
  for (const teamId of teamIds) {
    let next: { skillId: string; version: number } | undefined;
    do {
      const tally = emptyTally();
      next = await teamBatch(ctx, teamId, tally, next);
      await batchDone(tally, teamId);
    } while (next);
  }

  // Rows written meanwhile (or left by failures) keep the run open; the next tick takes them.
  const left = await anyStale(ctx, teamIds);
  const status = totals.failed > 0 ? "failed" : left ? "running" : "done";
  if (totals.scanned > 0 || totals.failed > 0 || run.status !== status) {
    await db
      .update(skillRescanRuns)
      .set({ status, finishedAt: status === "running" ? null : new Date(), failed: totals.failed })
      .where(eq(skillRescanRuns.id, run.id));
  }
  if (totals.scanned > 0 || totals.failed > 0)
    deps.log.info({ ruleSet, ...totals, status }, "skills: rescan pass finished");
  return { ruleSet, ruleSetVersion, ran: true, ...totals, status };
}

/**
 * One rescan pass for the current rule set, on this replica if no other holds the lease (a
 * session advisory lock on a dedicated connection). Null when another replica holds it.
 */
export async function rescanOnce(deps: RescanDeps): Promise<RescanReport | null> {
  const ruleSet = deps.ruleSet ?? RULE_SET;
  const ruleSetVersion = deps.ruleSetVersion ?? RULE_SET_VERSION;
  const client = await deps.database.pool.connect();
  let destroy = false;
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked`,
      [RESCAN_LOCK],
    );
    if (!rows[0]?.locked) return null;
    try {
      return await runPass(deps, ruleSet, ruleSetVersion);
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

/** How often each server runs a pass (cheap when nothing is stale). */
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
