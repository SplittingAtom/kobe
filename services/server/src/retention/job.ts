import {
  SYSTEM_ACTOR,
  asc,
  eq,
  installSettings,
  teams,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import type pg from "pg";
import type { Logger } from "pino";
import { recordAudit } from "../audit/record.js";
import { deleteReleasedBlobs, type BlobDeletionCounts, type BlobStore } from "./blobs.js";
import { compactRunEvents, type CompactionCounts } from "./compaction.js";
import { PERIOD_DAYS, shorterPeriod } from "./periods.js";
import {
  NO_PURGE,
  purgeThreads,
  type PurgeBatchResult,
  type PurgeCounts,
  type PurgeOutcome,
  type PurgeSelection,
} from "./purge.js";
import { readMaximum, readTeamPeriod } from "./settings.js";

/**
 * The nightly retention job (spec D18, KOBE-18). For every team, in short batches:
 *  1. purge threads 30 days in Trash (and those the owner deleted for good while held);
 *  2. purge threads past the team's effective retention period (team period capped by the
 *     install maximum; nothing when forever);
 *  3. compact the live events of runs that ended more than 7 days ago;
 *  4. delete the object-store keys purges released.
 * Every step skips data under legal hold and is audited with counts only (system actor).
 *
 * Every server replica runs the timer; a session-level advisory lock on a dedicated connection
 * lets exactly one replica run a pass (the lock goes with the connection if the replica dies),
 * and `install_settings['retention.last_pass_at']` makes it once a day, in the configured UTC hour
 * (or at once when the last pass is more than two days old, e.g. after downtime).
 */

export const RETENTION_LOCK = "kobe.retention";
export const LAST_PASS_KEY = "retention.last_pass_at";
/** How often each replica looks whether a pass is due. */
export const RETENTION_CHECK_INTERVAL_MS = 15 * 60_000;
/** Longest a pass works before leaving the rest to the next one. */
export const PASS_BUDGET_MS = 2 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;

export interface TeamPassResult {
  readonly teamId: string;
  readonly trash: PurgeCounts;
  readonly retention: PurgeCounts;
  readonly compacted: CompactionCounts;
  readonly blobs: BlobDeletionCounts;
  /** A step failed (logged); the others still ran. */
  readonly failed: boolean;
}

export interface PassResult {
  readonly teams: readonly TeamPassResult[];
}

export interface PassDeps {
  readonly db: KobeDb;
  /** Object storage for released keys; without it they stay queued. */
  readonly blobs?: BlobStore | undefined;
  readonly logger: Logger;
}

type Reason = "retention" | "trash" | "offboarding";

/** The `retention.purged` audit writer for one reason (counts only; last write of the batch). */
export function purgeRecorder(teamId: string, reason: Reason, userId?: string) {
  return async (tx: KobeTx, counts: PurgeBatchResult): Promise<void> => {
    await recordAudit(tx, {
      action: "retention.purged",
      actor: SYSTEM_ACTOR,
      teamId,
      target: {
        reason,
        threads: counts.threads,
        entries: counts.entries,
        runs: counts.runs,
        events: counts.events,
        blobs: counts.blobs,
        ...(userId ? { userId } : {}),
      },
    });
  };
}

export function blobRecorder(teamId: string) {
  return async (tx: KobeTx, counts: BlobDeletionCounts): Promise<void> => {
    await recordAudit(tx, {
      action: "retention.blobs_deleted",
      actor: SYSTEM_ACTOR,
      teamId,
      target: { blobs: counts.blobs, kept: counts.kept },
    });
  };
}

function compactionRecorder(teamId: string) {
  return async (tx: KobeTx, counts: CompactionCounts): Promise<void> => {
    await recordAudit(tx, {
      action: "retention.compacted",
      actor: SYSTEM_ACTOR,
      teamId,
      target: { runs: counts.runs, events: counts.events },
    });
  };
}

function logHeld(deps: PassDeps, teamId: string, step: string, outcome: PurgeOutcome): void {
  // Expected when a hold covers part of the team: the selection excludes held threads, so this
  // only happens when a guard caught something the selection missed. Logged without details.
  if (outcome.status === "held")
    deps.logger.warn({ teamId, step }, "retention purge skipped: held");
}

async function teamPass(deps: PassDeps, teamId: string, deadline: number): Promise<TeamPassResult> {
  const { db, logger } = deps;
  let failed = false;
  const step = async <T>(name: string, fallback: T, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      failed = true;
      logger.error({ err, teamId, step: name }, "retention step failed");
      return fallback;
    }
  };
  const run = async (selection: PurgeSelection, reason: Reason) => {
    const outcome = await purgeThreads(db, teamId, selection, purgeRecorder(teamId, reason), {
      deadline,
    });
    logHeld(deps, teamId, reason, outcome);
    return outcome.counts;
  };

  const trash = await step("trash", NO_PURGE, () => run({ kind: "trash" }, "trash"));
  const effective = await step("period", "forever" as const, () =>
    withTeam(db, teamId, async (tx) =>
      shorterPeriod(await readTeamPeriod(tx, teamId), await readMaximum(tx)),
    ),
  );
  const days = PERIOD_DAYS[effective];
  const retention =
    days === null
      ? NO_PURGE
      : await step("retention", NO_PURGE, () => run({ kind: "retention", days }, "retention"));
  const compacted = await step("compaction", { runs: 0, events: 0 }, () =>
    compactRunEvents(db, teamId, compactionRecorder(teamId), { deadline }),
  );
  const blobs = deps.blobs
    ? await step("blobs", { blobs: 0, kept: 0 }, () =>
        deleteReleasedBlobs(db, teamId, deps.blobs as BlobStore, blobRecorder(teamId), {
          deadline,
        }),
      )
    : { blobs: 0, kept: 0 };
  return { teamId, trash, retention, compacted, blobs, failed };
}

/** One full pass over every team (the caller holds the job lock). Also called by tests. */
export async function runRetentionPass(
  deps: PassDeps,
  options: { readonly budgetMs?: number } = {},
): Promise<PassResult> {
  const deadline = Date.now() + (options.budgetMs ?? PASS_BUDGET_MS);
  const all = await deps.db.select({ id: teams.id }).from(teams).orderBy(asc(teams.id));
  const results: TeamPassResult[] = [];
  for (const { id } of all) {
    if (Date.now() >= deadline) {
      deps.logger.warn("retention pass budget spent; the next pass continues");
      break;
    }
    results.push(await teamPass(deps, id, deadline));
  }
  return { teams: results };
}

/** Whether a pass is due at `now` given the last pass start (see the module comment). */
export function passDue(last: Date | null, now: Date, hourUtc: number): boolean {
  if (last === null) return true;
  const since = now.getTime() - last.getTime();
  if (since >= 48 * HOUR_MS) return true;
  return since >= 20 * HOUR_MS && now.getUTCHours() === hourUtc;
}

async function readLastPass(db: KobeDb): Promise<Date | null> {
  const [row] = await db
    .select({ value: installSettings.value })
    .from(installSettings)
    .where(eq(installSettings.key, LAST_PASS_KEY));
  const at = row ? new Date(row.value) : null;
  return at && !Number.isNaN(at.getTime()) ? at : null;
}

async function writeLastPass(db: KobeDb, at: Date): Promise<void> {
  const value = at.toISOString();
  await db
    .insert(installSettings)
    .values({ key: LAST_PASS_KEY, value })
    .onConflictDoUpdate({ target: installSettings.key, set: { value, updatedAt: new Date() } });
}

export interface RetentionJobOptions extends PassDeps {
  /** For the job's lock connection (session-level advisory lock). */
  readonly pool: pg.Pool;
  /** UTC hour the nightly pass runs in (0–23). */
  readonly hourUtc: number;
  readonly now?: () => Date;
}

export type TickResult = "ran" | "busy" | "not_due";

export class RetentionJob {
  private timer: ReturnType<typeof setInterval> | undefined;
  private first: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<unknown> | undefined;

  constructor(private readonly options: RetentionJobOptions) {}

  /** Takes the job lock, runs a pass when due, records its start. */
  async tick(force = false): Promise<TickResult> {
    const { pool, db, logger } = this.options;
    const client = await pool.connect();
    let locked = false;
    try {
      const res = await client.query<{ ok: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok",
        [RETENTION_LOCK],
      );
      locked = res.rows[0]?.ok === true;
      if (!locked) return "busy";
      const now = this.options.now?.() ?? new Date();
      if (!force && !passDue(await readLastPass(db), now, this.options.hourUtc)) return "not_due";
      const result = await runRetentionPass(this.options);
      await writeLastPass(db, now);
      const total = result.teams.reduce(
        (sum, t) => ({
          threads: sum.threads + t.trash.threads + t.retention.threads,
          runs: sum.runs + t.compacted.runs,
          blobs: sum.blobs + t.blobs.blobs,
          failed: sum.failed + (t.failed ? 1 : 0),
        }),
        { threads: 0, runs: 0, blobs: 0, failed: 0 },
      );
      logger.info({ teams: result.teams.length, ...total }, "retention pass finished");
      return "ran";
    } finally {
      let broken = false;
      if (locked) {
        try {
          await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
            RETENTION_LOCK,
          ]);
        } catch (err) {
          // Never return a connection that may still hold the lock to the pool: close it, which
          // releases a session lock for sure.
          broken = true;
          logger.warn({ err }, "retention lock release failed; closing its connection");
        }
      }
      client.release(broken);
    }
  }

  start(intervalMs: number = RETENTION_CHECK_INTERVAL_MS): void {
    const run = () => {
      if (this.running) return;
      this.running = this.tick()
        .catch((err: unknown) => this.options.logger.error({ err }, "retention job failed"))
        .finally(() => {
          this.running = undefined;
        });
    };
    // Jittered first check, so replicas started together don't all race for the lock at once.
    this.first ??= setTimeout(run, Math.floor(Math.random() * 60_000));
    this.first.unref();
    this.timer ??= setInterval(run, intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
    this.timer = undefined;
    this.first = undefined;
    await this.running;
  }
}
