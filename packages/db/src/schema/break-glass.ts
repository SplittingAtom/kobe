import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { teams } from "./teams.js";

/**
 * Lifecycle of a break-glass grant (spec D10). `approved` grants read access only while
 * `starts_at <= now() < expires_at`; `expired` is written by the expiry sweep afterwards (and for
 * requests nobody decided in time), but access never depends on the sweep having run.
 */
export const breakGlassStatus = pgEnum("break_glass_status", [
  "pending",
  "approved",
  "denied",
  "revoked",
  "expired",
]);
export type BreakGlassStatus = (typeof breakGlassStatus.enumValues)[number];

/** Longest window a grant may have (D10: 24 h max). */
export const BREAK_GLASS_MAX_MINUTES = 24 * 60;
/** Default window (D10: 1 h). */
export const BREAK_GLASS_DEFAULT_MINUTES = 60;
/** How long a request waits for a second person before it lapses. */
export const BREAK_GLASS_REQUEST_TTL_HOURS = 24;
export const BREAK_GLASS_REASON_MAX = 2000;

/**
 * Install-wide (§5.4 `break_glass_grants†`): an install admin's request for read-only access to one
 * team's content, optionally narrowed to one user or one thread (D10). It must exist before any
 * team context does and be visible to every install admin who may approve it, so it is not a team
 * table; it holds no team content (the reason is the requester's own text; `thread_id` is an id).
 *
 * The two-person rule, the approver's role, the time box and the allowed status transitions are
 * enforced by the `break_glass_grants_guard` trigger (migration `*_break_glass_guard.sql`), not
 * only by the server. Access is checked by `readWithBreakGlass()`, which sets the team context only
 * after verifying an active grant for the requesting admin inside the same transaction.
 * Grants are never deleted (no DELETE privilege): they are the record behind the audit events.
 */
export const breakGlassGrants = pgTable(
  "break_glass_grants",
  {
    id: uuid().primaryKey().defaultRandom(),
    // Teams are never deleted (no DELETE grant), so no cascade is needed or wanted.
    teamId: uuid()
      .notNull()
      .references(() => teams.id),
    /** The install admin who asked; the only person who can read with the grant. */
    adminId: uuid()
      .notNull()
      .references(() => users.id),
    /** The second install admin (or Owner) who approved; the requester only when self-approved. */
    approverId: uuid().references(() => users.id),
    /** Narrows the grant to threads owned by one user (the subject). */
    userId: uuid().references(() => users.id),
    /** Narrows the grant to one thread. No foreign key: threads are a team table. */
    threadId: uuid(),
    reason: text().notNull(),
    /** Legal hold: the subject user is not notified (D10). */
    legalHold: boolean().notNull().default(false),
    durationMinutes: integer().notNull().default(BREAK_GLASS_DEFAULT_MINUTES),
    status: breakGlassStatus().notNull().default("pending"),
    /** Single-admin install: the requester approved their own request (D10: flagged). */
    selfApproved: boolean().notNull().default(false),
    requestedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** A pending request can't be approved after this (set by the guard trigger). */
    requestExpiresAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** When it was approved, denied, revoked or expired. */
    decidedAt: timestamp({ withTimezone: true }),
    /** Who denied or revoked it (approvals are `approver_id`). */
    decidedBy: uuid().references(() => users.id),
    /** Access window, assigned by the guard trigger on approval: now() + duration. */
    startsAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }),
    /** When access ended early (revocation) or the sweep recorded its expiry. */
    endedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("break_glass_grants_team_idx").on(t.teamId, t.requestedAt.desc()),
    index("break_glass_grants_status_idx").on(t.status, t.requestedAt.desc()),
    // The expiry sweep: approved grants past their window, pending requests past their deadline.
    index("break_glass_grants_open_idx")
      .on(t.expiresAt, t.requestExpiresAt)
      .where(sql`${t.status} IN ('pending', 'approved')`),
    check(
      "break_glass_grants_reason",
      sql`char_length(btrim(${t.reason})) BETWEEN 1 AND ${sql.raw(String(BREAK_GLASS_REASON_MAX))}`,
    ),
    check(
      "break_glass_grants_duration",
      sql`${t.durationMinutes} BETWEEN 1 AND ${sql.raw(String(BREAK_GLASS_MAX_MINUTES))}`,
    ),
    check("break_glass_grants_one_narrowing", sql`${t.userId} IS NULL OR ${t.threadId} IS NULL`),
    check(
      "break_glass_grants_subject_not_requester",
      sql`${t.userId} IS DISTINCT FROM ${t.adminId}`,
    ),
    check(
      "break_glass_grants_two_person",
      sql`${t.approverId} IS NULL OR (${t.approverId} = ${t.adminId}) = ${t.selfApproved}`,
    ),
    check(
      "break_glass_grants_window",
      sql`(${t.startsAt} IS NULL) = (${t.expiresAt} IS NULL) AND (${t.startsAt} IS NULL OR (${t.expiresAt} > ${t.startsAt} AND ${t.expiresAt} <= ${t.startsAt} + interval '24 hours'))`,
    ),
    check(
      "break_glass_grants_approved_shape",
      sql`${t.status} <> 'approved' OR (${t.approverId} IS NOT NULL AND ${t.startsAt} IS NOT NULL)`,
    ),
  ],
);
