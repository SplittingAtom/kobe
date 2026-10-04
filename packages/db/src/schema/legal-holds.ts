import { sql } from "drizzle-orm";
import { boolean, check, index, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { teams } from "./teams.js";

/**
 * Lifecycle of a legal hold (spec D18, KOBE-17). Only `active` holds suspend purges; a hold stays
 * `active` while its release waits for a second install admin.
 */
export const legalHoldStatus = pgEnum("legal_hold_status", [
  "pending",
  "active",
  "denied",
  "withdrawn",
  "released",
]);
export type LegalHoldStatus = (typeof legalHoldStatus.enumValues)[number];

export const LEGAL_HOLD_REASON_MAX = 2000;

/**
 * Install-wide (§5.4 `legal_holds†`): an install admin's hold on one team's data, or on one user's
 * data in that team, which suspends every purge of it (D18: retention, Trash purge, offboarding
 * volume deletion) and the erasure of the audit log's IP and user agent. Placing and releasing a
 * hold need a second install admin (D10's two-person rule; a single-admin install self-approves,
 * flagged). The rules and transitions are enforced by the `legal_holds_guard` trigger (migration
 * `*_legal_hold.sql`); the server's checks only answer with clear errors. Never deleted: it is the
 * record behind the `governance.legal_hold.*` audit events. Holds no team content (ids and the
 * requester's reason).
 */
export const legalHolds = pgTable(
  "legal_holds",
  {
    id: uuid().primaryKey().defaultRandom(),
    // Teams are never deleted (no DELETE grant), so no cascade is needed or wanted.
    teamId: uuid()
      .notNull()
      .references(() => teams.id),
    /** The held user (their data in this team); null holds the whole team. */
    userId: uuid().references(() => users.id),
    reason: text().notNull(),
    status: legalHoldStatus().notNull().default("pending"),
    /** The install admin who asked for the hold. */
    placedBy: uuid()
      .notNull()
      .references(() => users.id),
    requestedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** The second install admin who approved; the requester only when self-approved. */
    approvedBy: uuid().references(() => users.id),
    approvedAt: timestamp({ withTimezone: true }),
    /** Single-admin install: the requester approved their own hold (D10: flagged). */
    selfApproved: boolean().notNull().default(false),
    /** Who denied (another admin) or withdrew (the requester) a pending hold, and when. */
    closedBy: uuid().references(() => users.id),
    closedAt: timestamp({ withTimezone: true }),
    /** An open release request: the hold stays active until a second admin approves it. */
    releaseRequestedBy: uuid().references(() => users.id),
    releaseRequestedAt: timestamp({ withTimezone: true }),
    releaseReason: text(),
    /** Who approved the release (the release requester only when self-approved), and when. */
    releasedBy: uuid().references(() => users.id),
    releasedAt: timestamp({ withTimezone: true }),
    releaseSelfApproved: boolean().notNull().default(false),
  },
  (t) => [
    index("legal_holds_team_idx").on(t.teamId, t.requestedAt.desc()),
    // Purge checks: active holds of one team (and user).
    index("legal_holds_active_idx")
      .on(t.teamId, t.userId)
      .where(sql`${t.status} = 'active'`),
    // Audit erasure: active user holds by subject, across teams.
    index("legal_holds_active_user_idx")
      .on(t.userId)
      .where(sql`${t.status} = 'active' AND ${t.userId} IS NOT NULL`),
    check(
      "legal_holds_reason",
      sql`char_length(btrim(${t.reason})) BETWEEN 1 AND ${sql.raw(String(LEGAL_HOLD_REASON_MAX))}`,
    ),
    check(
      "legal_holds_release_reason",
      sql`${t.releaseReason} IS NULL OR char_length(btrim(${t.releaseReason})) BETWEEN 1 AND ${sql.raw(String(LEGAL_HOLD_REASON_MAX))}`,
    ),
    check("legal_holds_subject_not_requester", sql`${t.userId} IS DISTINCT FROM ${t.placedBy}`),
    check(
      "legal_holds_two_person",
      sql`${t.approvedBy} IS NULL OR (${t.approvedBy} = ${t.placedBy}) = ${t.selfApproved}`,
    ),
    check(
      "legal_holds_release_two_person",
      sql`${t.releasedBy} IS NULL OR (${t.releasedBy} = ${t.releaseRequestedBy}) = ${t.releaseSelfApproved}`,
    ),
    check(
      "legal_holds_active_shape",
      sql`${t.status} NOT IN ('active', 'released') OR (${t.approvedBy} IS NOT NULL AND ${t.approvedAt} IS NOT NULL)`,
    ),
    check(
      "legal_holds_released_shape",
      sql`(${t.status} = 'released') = (${t.releasedBy} IS NOT NULL AND ${t.releasedAt} IS NOT NULL)`,
    ),
    check(
      "legal_holds_release_request_shape",
      sql`(${t.releaseRequestedBy} IS NULL) = (${t.releaseRequestedAt} IS NULL) AND (${t.releaseRequestedBy} IS NULL) = (${t.releaseReason} IS NULL) AND (${t.releaseRequestedBy} IS NULL OR ${t.status} IN ('active', 'released'))`,
    ),
  ],
);
