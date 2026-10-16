import { randomUUID } from "node:crypto";
import { and, asc, eq, isNotNull, lte, schedules, teams, withTeam, type KobeDb } from "@kobe/db";
import type { ActorContext } from "@kobe/protocol";
import type { Logger } from "pino";
import { logger as rootLogger } from "../logger.js";
import { RunError } from "../runs/errors.js";
import type { ServerRunOrchestrator } from "../runs/orchestrator.js";
import { recordSkip, ScheduleSkip, scheduledFire, type DueSchedule } from "./fire.js";
import { sweepInactiveOwners } from "./owner-sweep.js";

export interface SchedulerRunnerOptions {
  readonly db: KobeDb;
  readonly runs: Pick<ServerRunOrchestrator, "submitMessage" | "cancelScheduledRuns">;
  /** The clock; tests inject a fixed one. */
  readonly now?: () => Date;
  /** How late an occurrence may still fire (catch-up after downtime). */
  readonly graceMs: number;
  /** Due schedules handled per team per tick. */
  readonly batchSize?: number;
  readonly log?: Logger;
}

export interface TickResult {
  readonly fired: number;
  readonly skipped: number;
  readonly failed: number;
}

const DEFAULT_BATCH = 50;

/** The schedule's owner acts with no standing role: the run gate checks active and member. */
const ownerActor = (due: DueSchedule): ActorContext => ({
  user_id: due.userId,
  team_id: due.teamId,
  site_role: "user",
  team_role: "member",
});

/**
 * The Postgres-leased schedule runner (KOBE-174, D32). Every replica ticks; per team (under
 * `withTeam`) it reads the due schedules without a lock, then fires each in ONE short transaction
 * that leases the row (`FOR UPDATE SKIP LOCKED`), claims the occurrence (the `schedule.fire` event,
 * unique per occurrence) and creates the thread and run. A replica that dies mid-fire rolls back
 * and releases the lease with its connection, so the occurrence stays due for the next tick.
 * No transaction spans the sandbox start: dispatch happens after the commit.
 */
export class SchedulerRunner {
  readonly #opts: SchedulerRunnerOptions;
  readonly #log: Logger;
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(options: SchedulerRunnerOptions) {
    this.#opts = options;
    this.#log = options.log ?? rootLogger.child({ component: "scheduler" });
  }

  start(everyMs: number): void {
    const run = () => {
      if (this.#running) return;
      this.#running = true;
      this.tick()
        .catch((err: unknown) => this.#log.error({ err }, "scheduler tick failed"))
        .finally(() => {
          this.#running = false;
        });
    };
    run();
    this.#timer = setInterval(run, everyMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * One pass over every team: fire what is due, then finish stopping the schedules of owners who
   * were deactivated or removed (KOBE-252, owner-sweep.ts). A failing team is logged and does not
   * stop the others.
   */
  async tick(): Promise<TickResult> {
    let fired = 0;
    let skipped = 0;
    let failed = 0;
    const all = await this.#opts.db.select({ id: teams.id }).from(teams);
    for (const { id: teamId } of all) {
      try {
        for (const due of await this.#due(teamId)) {
          const outcome = await this.#fire(due);
          if (outcome === "fired") fired += 1;
          else if (outcome === "skipped") skipped += 1;
          else if (outcome === "failed") failed += 1;
        }
        await sweepInactiveOwners(
          { db: this.#opts.db, runs: this.#opts.runs, log: this.#log },
          teamId,
        );
      } catch (err) {
        failed += 1;
        this.#log.error({ err, team_id: teamId }, "scheduler pass failed for a team");
      }
    }
    return { fired, skipped, failed };
  }

  #now(): Date {
    return this.#opts.now?.() ?? new Date();
  }

  async #due(teamId: string): Promise<DueSchedule[]> {
    const now = this.#now();
    const rows = await withTeam(this.#opts.db, teamId, (tx) =>
      tx
        .select()
        .from(schedules)
        .where(
          and(
            eq(schedules.teamId, teamId),
            eq(schedules.active, true),
            isNotNull(schedules.nextDueAt),
            lte(schedules.nextDueAt, now),
          ),
        )
        .orderBy(asc(schedules.nextDueAt), asc(schedules.id))
        .limit(this.#opts.batchSize ?? DEFAULT_BATCH),
    );
    return rows.flatMap((r) =>
      r.nextDueAt
        ? [
            {
              teamId,
              id: r.id,
              userId: r.userId,
              agentId: r.agentId,
              prompt: r.prompt,
              dueAt: r.nextDueAt,
            },
          ]
        : [],
    );
  }

  async #fire(due: DueSchedule): Promise<"fired" | "skipped" | "busy" | "failed"> {
    const now = this.#now();
    const threadId = randomUUID();
    const scheduled = scheduledFire(due, { threadId, now, graceMs: this.#opts.graceMs });
    try {
      const result = await this.#opts.runs.submitMessage(
        ownerActor(due),
        { thread_id: threadId, content: due.prompt, trigger: "schedule", approval_mode: "auto" },
        { scheduled },
      );
      this.#log.info(
        { team_id: due.teamId, schedule_id: due.id, run_id: result.run_id },
        "scheduled run created",
      );
      return "fired";
    } catch (err) {
      if (err instanceof ScheduleSkip) return this.#skip(due, err, now);
      // Not a decision about the schedule (isolation down, lock timeout): the next tick retries.
      this.#log.warn(
        {
          err,
          team_id: due.teamId,
          schedule_id: due.id,
          code: err instanceof RunError ? err.code : undefined,
        },
        "scheduled run could not be created",
      );
      return "failed";
    }
  }

  async #skip(due: DueSchedule, skip: ScheduleSkip, now: Date): Promise<"skipped" | "busy"> {
    if (skip.reason === "busy" || skip.reason === "stale" || skip.plan === undefined) return "busy";
    const plan = skip.plan;
    await withTeam(this.#opts.db, due.teamId, async (tx) => {
      // Consume the occurrence only if nobody else did (the row still shows the scanned due time).
      const [row] = await tx
        .select()
        .from(schedules)
        .where(and(eq(schedules.teamId, due.teamId), eq(schedules.id, due.id)))
        .for("update", { skipLocked: true });
      if (!row || row.nextDueAt?.getTime() !== due.dueAt.getTime() || !row.active) return;
      await recordSkip(tx, due, skip.reason, plan, now);
    });
    this.#log.info(
      { team_id: due.teamId, schedule_id: due.id, reason: skip.reason },
      "scheduled run skipped",
    );
    return "skipped";
  }
}
