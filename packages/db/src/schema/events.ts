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
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    // Work queue: pending and due events, oldest first.
    index("events_queue_idx")
      .on(t.teamId, t.status, t.dueAt)
      .where(sql`${t.status} IN ('pending', 'scheduled')`),
    check("events_due_at", sql`${t.status} <> 'scheduled' OR ${t.dueAt} IS NOT NULL`),
    check("events_kind_format", sql`${t.kind} ~ '^[a-z][a-z_]*(\\.[a-z][a-z_]*)*$'`),
  ],
);
