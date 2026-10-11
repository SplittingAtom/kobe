import { and, eq, events, schedules, sql, type KobeTx } from "@kobe/db";
import type { ScheduleRecurrence } from "@kobe/protocol";
import { resolveAgentPin } from "../agents/versions.js";
import { principalActive } from "../runs/store.js";
import type { ScheduledSubmit } from "../runs/scheduled-submit.js";
import { createThread } from "../threads/repository.js";
import { planFire, type FirePlan } from "./plan.js";

/** A schedule the scan found due; the fire transaction re-reads and re-checks all of it. */
export interface DueSchedule {
  readonly teamId: string;
  readonly id: string;
  readonly userId: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly dueAt: Date;
}

/**
 * Why a due occurrence did not fire. `busy` and `stale` change nothing (another replica holds the
 * row, or the schedule changed since the scan: the next tick sees it again). The rest are
 * decisions: the occurrence is consumed, `next_due_at` moves on and a `schedule.skip` is recorded.
 */
export type SkipReason =
  "busy" | "stale" | "user_inactive" | "agent_unavailable" | "missed" | "duplicate";

export class ScheduleSkip extends Error {
  constructor(
    readonly reason: SkipReason,
    /** The plan the decision was taken with (to advance `next_due_at`); absent for busy/stale. */
    readonly plan?: FirePlan,
  ) {
    super(`schedule not fired: ${reason}`);
    this.name = "ScheduleSkip";
  }
}

export interface FireContext {
  readonly threadId: string;
  readonly now: Date;
  readonly graceMs: number;
}

const TITLE_MAX = 80;
const titleOf = (prompt: string): string =>
  (prompt.split("\n")[0] ?? "").trim().slice(0, TITLE_MAX);

/** The schedule row under `FOR UPDATE SKIP LOCKED`: this lock is the lease (held until commit). */
async function leaseRow(tx: KobeTx, due: DueSchedule) {
  const [row] = await tx
    .select()
    .from(schedules)
    .where(and(eq(schedules.teamId, due.teamId), eq(schedules.id, due.id)))
    .for("update", { skipLocked: true });
  return row;
}

/** Records the skipped occurrences and moves the schedule on (no run is created). */
export async function recordSkip(
  tx: KobeTx,
  due: DueSchedule,
  reason: SkipReason,
  plan: FirePlan,
  now: Date,
): Promise<void> {
  await tx
    .update(schedules)
    .set({ nextDueAt: plan.next })
    .where(and(eq(schedules.teamId, due.teamId), eq(schedules.id, due.id)));
  await tx.insert(events).values({
    teamId: due.teamId,
    kind: "schedule.skip",
    status: "processed",
    ref: { schedule_id: due.id, reason, skipped_at: now.toISOString() },
    dueAt: due.dueAt,
  });
}

/**
 * The hooks that run inside the submit transaction (see `ScheduledSubmit`). `before` leases the
 * schedule row, re-checks it, and either throws `ScheduleSkip` or claims the occurrence: the fire
 * event (`ON CONFLICT DO NOTHING` on `events_schedule_fire_uniq` is the last guard), the thread in
 * the Scheduled folder, and the new `next_due_at`.
 */
export function scheduledFire(due: DueSchedule, ctx: FireContext): ScheduledSubmit {
  let eventId: string | undefined;
  return {
    async before(tx) {
      const row = await leaseRow(tx, due);
      if (!row) throw new ScheduleSkip("busy");
      const unchanged =
        row.active &&
        row.nextDueAt?.getTime() === due.dueAt.getTime() &&
        row.prompt === due.prompt &&
        row.agentId === due.agentId &&
        row.userId === due.userId;
      if (!unchanged || !row.nextDueAt) throw new ScheduleSkip("stale");
      const plan = planFire({
        recurrence: row.recurrence as unknown as ScheduleRecurrence,
        tz: row.tz,
        dueAt: row.nextDueAt,
        now: ctx.now,
        graceMs: ctx.graceMs,
      });
      if (!(await principalActive(tx, due.teamId, row.userId))) {
        throw new ScheduleSkip("user_inactive", plan);
      }
      const pin = await resolveAgentPin(
        tx,
        { teamId: due.teamId, userId: row.userId },
        row.agentId,
      );
      if (!pin.ok) throw new ScheduleSkip("agent_unavailable", plan);
      if (plan.fireAt === null) throw new ScheduleSkip("missed", plan);
      const [fired] = await tx
        .insert(events)
        .values({
          teamId: due.teamId,
          kind: "schedule.fire",
          status: "processed",
          ref: { schedule_id: due.id, thread_id: ctx.threadId },
          dueAt: plan.fireAt,
        })
        .onConflictDoNothing()
        .returning({ id: events.id });
      if (!fired) throw new ScheduleSkip("duplicate", plan);
      eventId = fired.id;
      if (plan.skippedBefore) {
        await tx.insert(events).values({
          teamId: due.teamId,
          kind: "schedule.skip",
          status: "processed",
          ref: { schedule_id: due.id, reason: "collapsed", fired_for: plan.fireAt.toISOString() },
          dueAt: due.dueAt,
        });
      }
      await createThread(tx, {
        teamId: due.teamId,
        ownerUserId: row.userId,
        projectId: null,
        id: ctx.threadId,
        agent: pin.value,
        title: titleOf(row.prompt) || null,
        scheduleId: due.id,
      });
      await tx
        .update(schedules)
        .set({ nextDueAt: plan.next, lastFiredAt: ctx.now })
        .where(and(eq(schedules.teamId, due.teamId), eq(schedules.id, due.id)));
    },
    async after(tx, outcome) {
      await tx
        .update(schedules)
        .set({ lastRunId: outcome.runId })
        .where(and(eq(schedules.teamId, due.teamId), eq(schedules.id, due.id)));
      if (eventId === undefined) throw new Error("schedule.fire event missing in its transaction");
      const patch = JSON.stringify({
        run_id: outcome.runId,
        ...(outcome.budgetBlocked ? { outcome: "budget_blocked" } : {}),
      });
      await tx
        .update(events)
        .set({ ref: sql`${events.ref} || ${patch}::jsonb` })
        .where(and(eq(events.teamId, due.teamId), eq(events.id, eventId)));
    },
  };
}
