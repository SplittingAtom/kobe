import { jsonb, pgTable, timestamp, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Site table: the usage aggregates of catalog skills for one closed window (KOBE-339, SK26).
 * Windows are fixed, non-overlapping 30-day periods counted from the Unix epoch (UTC); once a
 * window closes, one server replica (under an advisory lock) computes its aggregates once and
 * stores them here, and every replica serves the last closed window's row, so the numbers never
 * change and never differ between replicas or restarts. `payload` holds each team's contribution
 * per catalog skill (team and user ids, to apply the minimum-count rule at read time); it is never
 * returned as is. Derived data: the job keeps the last two windows and purges older ones.
 */
export const skillUsageSnapshots = pgTable(
  "skill_usage_snapshots",
  {
    windowStart: timestamp({ withTimezone: true }).primaryKey(),
    windowEnd: timestamp({ withTimezone: true }).notNull(),
    computedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
  },
  (t) => [check("skill_usage_snapshots_window", sql`${t.windowStart} < ${t.windowEnd}`)],
);
