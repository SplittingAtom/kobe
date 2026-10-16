import {
  MAX_ACTIVE_SCHEDULES_PER_USER,
  type ScheduleRecurrence,
  type ScheduleResponse,
} from "@kobe/protocol";
import { and, desc, eq, schedules, sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { resolveAgentPin } from "../agents/versions.js";
import { recordAudit } from "../audit/record.js";
import { nextOccurrence, recurrenceToCron } from "./recurrence.js";

/**
 * Schedules repository (KOBE-173, spec D32). Every function runs inside `withTeam()` for the
 * request's team; `team_id` is still stated in each query. The per-user cap of 10 active
 * schedules spans ALL of a user's teams, which RLS hides from any one team's transaction, so
 * other teams are counted by `countActiveElsewhere` (one `withTeam()` each) while
 * `withUserScheduleLock` serializes every cap check and activation of that user.
 */

type Row = typeof schedules.$inferSelect;
export type ScheduleRow = Row;

export const toResponse = (row: Row): ScheduleResponse => ({
  schedule_id: row.id,
  team_id: row.teamId,
  user_id: row.userId,
  agent_id: row.agentId,
  prompt: row.prompt,
  mentions: row.mentions,
  recurrence: row.recurrence as ScheduleRecurrence,
  tz: row.tz,
  active: row.active,
  notify_email: row.notifyEmail,
  next_due_at: row.nextDueAt?.toISOString() ?? null,
  last_run_id: row.lastRunId,
  paused_by: row.pausedBy,
  created_at: row.createdAt.toISOString(),
  updated_at: row.updatedAt.toISOString(),
});

/** The first occurrence after now, or null when the recurrence never fires (e.g. Feb 31). */
export const nextDueAt = (recurrence: ScheduleRecurrence, tz: string): Date | null =>
  nextOccurrence(recurrence, tz, new Date());

/** Why an agent cannot be scheduled: not visible to the user here, suspended, archived or unpublished. */
export async function agentRunnable(
  tx: KobeTx,
  viewer: { teamId: string; userId: string },
  agentId: string,
): Promise<boolean> {
  return (await resolveAgentPin(tx, viewer, agentId)).ok;
}

export async function countActiveHere(tx: KobeTx, teamId: string, userId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schedules)
    .where(
      and(eq(schedules.teamId, teamId), eq(schedules.userId, userId), eq(schedules.active, true)),
    );
  return row?.n ?? 0;
}

/**
 * The user's active schedules in `teamIds`, one `withTeam()` per team (the only way the team is
 * ever set). Callers needing a stable number hold `withUserScheduleLock` around the whole check.
 */
export async function countActiveElsewhere(
  db: KobeDb,
  userId: string,
  teamIds: readonly string[],
): Promise<number> {
  let total = 0;
  for (const teamId of teamIds) {
    total += await withTeam(db, teamId, (tx) => countActiveHere(tx, teamId, userId));
  }
  return total;
}

export const atCap = (active: number): boolean => active >= MAX_ACTIVE_SCHEDULES_PER_USER;

export async function findSchedule(tx: KobeTx, teamId: string, id: string): Promise<Row | null> {
  const [row] = await tx
    .select()
    .from(schedules)
    .where(and(eq(schedules.teamId, teamId), eq(schedules.id, id)))
    .for("update");
  return row ?? null;
}

export async function listSchedules(
  tx: KobeTx,
  teamId: string,
  userId: string | null,
): Promise<Row[]> {
  const where =
    userId === null
      ? eq(schedules.teamId, teamId)
      : and(eq(schedules.teamId, teamId), eq(schedules.userId, userId));
  return tx.select().from(schedules).where(where).orderBy(desc(schedules.createdAt), schedules.id);
}

export interface NewSchedule {
  readonly teamId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly mentions: readonly string[];
  readonly recurrence: ScheduleRecurrence;
  readonly tz: string;
  readonly active: boolean;
  readonly notifyEmail: boolean;
  readonly nextDueAt: Date | null;
}

export async function insertSchedule(tx: KobeTx, input: NewSchedule): Promise<Row> {
  const [row] = await tx
    .insert(schedules)
    .values({
      teamId: input.teamId,
      userId: input.userId,
      agentId: input.agentId,
      prompt: input.prompt,
      mentions: [...input.mentions],
      recurrence: input.recurrence,
      cron: recurrenceToCron(input.recurrence),
      tz: input.tz,
      active: input.active,
      notifyEmail: input.notifyEmail,
      nextDueAt: input.nextDueAt,
    })
    .returning();
  if (!row) throw new Error("schedule insert returned no row");
  await recordAudit(tx, {
    action: "schedule.created",
    teamId: input.teamId,
    target: { scheduleId: row.id, agentId: row.agentId, active: row.active },
  });
  return row;
}

export interface SchedulePatch {
  readonly agentId?: string;
  readonly prompt?: string;
  readonly mentions?: readonly string[];
  readonly recurrence?: ScheduleRecurrence;
  readonly tz?: string;
  readonly active?: boolean;
  readonly notifyEmail?: boolean;
  readonly pausedBy?: "team_admin" | null;
  readonly nextDueAt?: Date | null;
}

export async function updateSchedule(
  tx: KobeTx,
  row: Row,
  patch: SchedulePatch,
  audit: {
    readonly fieldsChanged: boolean;
    readonly activation: "activated" | "deactivated" | null;
    readonly by: "owner" | "team_admin";
  },
): Promise<Row> {
  const [updated] = await tx
    .update(schedules)
    .set({
      ...(patch.agentId !== undefined ? { agentId: patch.agentId } : {}),
      ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
      ...(patch.mentions !== undefined ? { mentions: [...patch.mentions] } : {}),
      ...(patch.recurrence !== undefined
        ? { recurrence: patch.recurrence, cron: recurrenceToCron(patch.recurrence) }
        : {}),
      ...(patch.tz !== undefined ? { tz: patch.tz } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      ...(patch.notifyEmail !== undefined ? { notifyEmail: patch.notifyEmail } : {}),
      ...(patch.pausedBy !== undefined ? { pausedBy: patch.pausedBy } : {}),
      ...(patch.nextDueAt !== undefined ? { nextDueAt: patch.nextDueAt } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(schedules.teamId, row.teamId), eq(schedules.id, row.id)))
    .returning();
  if (!updated) throw new Error("schedule update returned no row");
  const base = { teamId: row.teamId } as const;
  if (audit.fieldsChanged) {
    await recordAudit(tx, {
      action: "schedule.updated",
      ...base,
      target: { scheduleId: row.id, agentId: updated.agentId },
    });
  }
  if (audit.activation !== null) {
    await recordAudit(tx, {
      action: audit.activation === "activated" ? "schedule.activated" : "schedule.deactivated",
      ...base,
      target: { scheduleId: row.id, by: audit.by },
    });
  }
  return updated;
}

export async function deleteSchedule(tx: KobeTx, row: Row): Promise<void> {
  await tx.delete(schedules).where(and(eq(schedules.teamId, row.teamId), eq(schedules.id, row.id)));
  await recordAudit(tx, {
    action: "schedule.deleted",
    teamId: row.teamId,
    target: { scheduleId: row.id },
  });
}
