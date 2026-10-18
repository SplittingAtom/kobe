import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** What a rescan suspended (ids, slug and scope only), at most {@link RESCAN_SUSPENDED_MAX}. */
export interface RescanSuspension {
  readonly scope: "team" | "personal" | "catalog";
  /** The team whose review row was suspended; absent for personal scans and catalog versions. */
  readonly teamId?: string;
  readonly skillId: string;
  /** Local version number, or the catalog version's id. */
  readonly version: number | string;
  readonly slug: string;
}

export const RESCAN_SUSPENDED_MAX = 100;

export const skillRescanStatus = ["running", "done", "failed"] as const;

/**
 * Site-wide (†): one rescan of every stored skill scan under a scanner rule set (KOBE-313, SK32),
 * one row per rule set. A replica that holds the rescan lease runs it; the row is its progress and
 * result for the Site console. Counts, ids and slugs only: never findings or content.
 */
export const skillRescanRuns = pgTable(
  "skill_rescan_runs",
  {
    id: uuid().primaryKey().defaultRandom(),
    ruleSetVersion: text().notNull().unique("skill_rescan_runs_rule_set_unique"),
    status: text().$type<(typeof skillRescanStatus)[number]>().notNull().default("running"),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
    /** Scans redone so far. */
    scanned: integer().notNull().default(0),
    /** Scans whose verdict changed. */
    changed: integer().notNull().default(0),
    /** Versions suspended (newly Block). */
    suspended: integer().notNull().default(0),
    /** Scans that could not be redone (bundle unreadable); retried by the next pass. */
    failed: integer().notNull().default(0),
    suspensions: jsonb().$type<RescanSuspension[]>().notNull().default([]),
  },
  (t) => [
    check("skill_rescan_runs_status", sql`${t.status} IN ('running', 'done', 'failed')`),
    check(
      "skill_rescan_runs_counts",
      sql`${t.scanned} >= 0 AND ${t.changed} >= 0 AND ${t.suspended} >= 0 AND ${t.failed} >= 0`,
    ),
    check(
      "skill_rescan_runs_suspensions",
      sql`jsonb_typeof(${t.suspensions}) = 'array' AND jsonb_array_length(${t.suspensions}) <= 100`,
    ),
    check("skill_rescan_runs_finished", sql`(${t.status} = 'running') = (${t.finishedAt} IS NULL)`),
  ],
);
