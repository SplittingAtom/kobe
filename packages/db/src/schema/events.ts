import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { teams } from "./teams.js";

export const eventStatus = pgEnum("event_status", ["pending", "processed", "failed", "scheduled"]);
export type EventStatus = (typeof eventStatus.enumValues)[number];

/**
 * Non-message happenings (D15): approvals, connector failures, schedule firings, request-access.
 * `kind` is a dotted name owned by the producing area; `ref` points at what it concerns. Scheduled
 * events carry `due_at`.
 */
export const events = pgTable(
  "events",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    id: uuid().notNull().defaultRandom(),
    kind: text().notNull(),
    status: eventStatus().notNull().default("pending"),
    ref: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    dueAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /**
     * The schedule a `schedule.fire` / `schedule.skip` concerns (KOBE-252), beside
     * `ref.schedule_id`. A typed column because the latest-event lookup must use an index under
     * RLS: only leakproof quals become index conditions there, and uuid equality is leakproof
     * while `lower(ref->>'schedule_id')` is not. NULL on other kinds and on events written before
     * KOBE-252.
     */
    scheduleId: uuid(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    // Work queues: pending events oldest first; scheduled events by due time.
    index("events_pending_idx")
      .on(t.teamId, t.createdAt, t.id)
      .where(sql`${t.status} = 'pending'`),
    index("events_scheduled_idx")
      .on(t.teamId, t.dueAt)
      .where(sql`${t.status} = 'scheduled'`),
    // Each occurrence of a schedule is recorded once (KOBE-172): racing runners hit the unique
    // index `events_schedule_fire_uniq` on (team_id, lower(ref->>'schedule_id'), due_at) WHERE
    // kind = 'schedule.fire'. SQL-only (migration `*_schedules_rls.sql`, IF NOT EXISTS so large
    // installs can build it CONCURRENTLY first, docs/install.md); not declared here.
    // The index only dedups non-null keys, so a fire must carry both.
    // A schedule's latest fire or skip (KOBE-252, scheduler skip dedupe): the index
    // `events_schedule_latest_idx` on (team_id, schedule_id, created_at DESC) WHERE kind IN
    // ('schedule.fire', 'schedule.skip'). SQL-only (hand-written migration
    // `*_events_schedule_latest.sql`, IF NOT EXISTS so large sites can build it CONCURRENTLY
    // first, docs/install.md); not declared here. The same migration adds the SQL-only check
    // `events_schedule_id_ref` (schedule_id IS NULL OR schedule_id::text =
    // lower(ref->>'schedule_id'), NOT VALID).
    check(
      "events_schedule_fire_keys",
      sql`${t.kind} <> 'schedule.fire' OR (${t.ref}->>'schedule_id' IS NOT NULL AND ${t.dueAt} IS NOT NULL)`,
    ),
    check("events_due_at", sql`${t.status} <> 'scheduled' OR ${t.dueAt} IS NOT NULL`),
    check("events_kind_format", sql`${t.kind} ~ '^[a-z][a-z_]*(\\.[a-z][a-z_]*)*$'`),
  ],
);
