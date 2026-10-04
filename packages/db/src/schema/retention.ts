import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { teams } from "./teams.js";

// Retention and deletion (spec D18, KOBE-18). Team tables (identity area): FORCE RLS on kobe.team_id.

/**
 * Retention periods a team admin may choose, and the install maximum's values (D18: 30 d / 90 d /
 * 1 y / forever). `forever` keeps everything (the default).
 */
export const RETENTION_PERIODS = ["30d", "90d", "1y", "forever"] as const;
export type RetentionPeriod = (typeof RETENTION_PERIODS)[number];

const periodList = sql.raw(RETENTION_PERIODS.map((p) => `'${p}'`).join(", "));

/** Install setting (`install_settings`) holding the install maximum; absent = `forever`. */
export const RETENTION_MAXIMUM_KEY = "retention.maximum";

/** Install setting holding a scheduled lowering of the maximum: `<period>@<ISO time>`. */
export const RETENTION_MAXIMUM_PENDING_KEY = "retention.maximum.pending";

/** Days a shortening waits before it applies (user decision 2026-10-04, KOBE-18). */
export const RETENTION_GRACE_DAYS = 7;

/**
 * A team's retention period (D6: team-scoped, team admins). No row = `forever`. `period` is the
 * period in force; a shortening is first recorded as `pending_period`, applied at `pending_at`
 * (7 days later) unless cancelled; a lengthening applies at once. The period the job uses is the
 * shorter of the team's and the install maximum's (each with its own grace), so lowering the
 * maximum caps every team without rewriting their choice.
 */
export const teamRetention = pgTable(
  "team_retention",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    period: text().$type<RetentionPeriod>().notNull(),
    updatedBy: uuid()
      .notNull()
      .references(() => users.id),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** A shorter period waiting out its grace period (null: none). */
    pendingPeriod: text().$type<RetentionPeriod>(),
    pendingAt: timestamp({ withTimezone: true }),
    pendingBy: uuid().references(() => users.id),
  },
  (t) => [
    primaryKey({ columns: [t.teamId] }),
    check("team_retention_period", sql`${t.period} IN (${periodList})`),
    check(
      "team_retention_pending",
      sql`(${t.pendingPeriod} IS NULL) = (${t.pendingAt} IS NULL) AND (${t.pendingPeriod} IS NULL) = (${t.pendingBy} IS NULL) AND (${t.pendingPeriod} IS NULL OR ${t.pendingPeriod} IN (${periodList}))`,
    ),
  ],
);

/**
 * Object-store keys whose referencing rows a purge deleted (D18: blobs, artifacts and uploads of
 * purged threads). Queued in the purge's own transaction, so the bytes can't outlive their rows
 * unnoticed, then deleted from S3 by the retention job once no registered column (`BLOB_REF_COLUMNS`)
 * of the team references the key any more and no legal hold covers its owner. Ids only, no content.
 */
export const retentionBlobDeletions = pgTable(
  "retention_blob_deletions",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    key: text().notNull(),
    /**
     * The purged thread: only keys in its own tree (`<prefix>teams/<team>/threads/<thread>/…`) are
     * ever deleted, so a crafted reference can't reach another thread's or member's objects.
     */
    threadId: uuid().notNull(),
    /** Owner of the purged thread (legal hold is checked again before the bytes go). */
    ownerUserId: uuid()
      .notNull()
      .references(() => users.id),
    enqueuedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Failed deletion attempts (the object store was unreachable); retried by later passes. */
    attempts: integer().notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.key] }),
    index("retention_blob_deletions_queue_idx").on(t.teamId, t.enqueuedAt),
    check("retention_blob_deletions_key", sql`char_length(${t.key}) BETWEEN 1 AND 1024`),
    check("retention_blob_deletions_attempts", sql`${t.attempts} >= 0`),
  ],
);
