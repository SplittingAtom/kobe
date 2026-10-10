import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { teams } from "./teams.js";

// Personal Schedules (KOBE-172, spec D32; contract: packages/protocol/src/schedules.ts). A
// schedule is a prompt an agent runs on a recurrence, as its owner. Team table: every team has its
// own. The per-user cap of 10 active schedules counts across ALL of a user's teams (contract), so
// it cannot be a per-team RLS-visible trigger; the server enforces it (KOBE-173).
//
// Fires are recorded as `events` rows of kind `schedule.fire` (`ref.schedule_id`, `due_at`); the
// partial unique index `events_schedule_fire_uniq` (SQL-only, migration 0087) rejects a second row for the
// same occurrence, so racing runners fire each occurrence once. `threads.schedule_id` marks the
// threads a schedule created (the "Scheduled" folder); its foreign key (ON DELETE SET NULL
// (schedule_id), which drizzle cannot express) is added in SQL by migration 0087 (schedules_rls).

export const SCHEDULE_PAUSED_BY = ["team_admin", "deactivation"] as const;
export type SchedulePausedBy = (typeof SCHEDULE_PAUSED_BY)[number];

export const schedules = pgTable(
  "schedules",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    id: uuid().notNull().defaultRandom(),
    // Users are deactivated, never deleted; NO ACTION keeps a stray delete from erasing schedules.
    userId: uuid()
      .notNull()
      .references(() => users.id),
    /** The agent to run. No foreign key: agents live in two tables; the runner re-checks it. */
    agentId: uuid().notNull(),
    prompt: text().notNull(),
    /** `scheduleRecurrenceSchema` (cron | daily | weekdays | weekly); `tz` is a sibling. */
    recurrence: jsonb().$type<Record<string, unknown>>().notNull(),
    /** Derived from `recurrence` by the server (presets map to a cron too). */
    cron: text(),
    /** IANA time zone name the recurrence is evaluated in. */
    tz: text().notNull(),
    active: boolean().notNull().default(true),
    notifyEmail: boolean().notNull().default(true),
    /** Why an inactive schedule is paused; null = the owner paused it (or it is active). */
    pausedBy: text().$type<SchedulePausedBy>(),
    /** Next occurrence; null while inactive. */
    nextDueAt: timestamp({ withTimezone: true }),
    /** The latest run it started (no foreign key: runs are purged by retention). */
    lastRunId: uuid(),
    lastFiredAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    check("schedules_prompt", sql`char_length(btrim(${t.prompt})) BETWEEN 1 AND 10000`),
    check("schedules_tz", sql`char_length(${t.tz}) BETWEEN 1 AND 64`),
    check("schedules_paused_by", sql`${t.pausedBy} IN ('team_admin', 'deactivation')`),
    check("schedules_paused_inactive", sql`${t.pausedBy} IS NULL OR NOT ${t.active}`),
    // The runner's due scan, team by team under RLS (active schedules by next occurrence).
    index("schedules_due_idx")
      .on(t.teamId, t.nextDueAt)
      .where(sql`${t.active} AND ${t.nextDueAt} IS NOT NULL`),
    // A user's schedules (list "mine", cap count) and the agent's (suspension, usage).
    index("schedules_user_idx").on(t.teamId, t.userId),
    index("schedules_agent_idx").on(t.teamId, t.agentId),
  ],
);
