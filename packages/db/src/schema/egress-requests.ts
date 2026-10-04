import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { DOMAIN_PATTERN_SQL } from "./egress.js";
import { teams } from "./teams.js";

// Request access (spec D28, U12; KOBE-39). A member whose sandbox was blocked from a domain asks the
// team's admins to enable it ("no user self-allow"); a team admin approves (enables the ceiling
// pattern) or denies, and the requester is told. Both are team tables.

export const egressRequestStatus = pgEnum("egress_request_status", [
  "pending",
  "approved",
  "denied",
]);
export type EgressRequestStatus = (typeof egressRequestStatus.enumValues)[number];

const domainCheck = (column: unknown) =>
  sql`char_length(${column}) <= 253 AND ${column} ~ ${sql.raw(`'${DOMAIN_PATTERN_SQL}'`)}`;

/**
 * One member's request for one host. `domain` is the host that was blocked; `pattern` the ceiling
 * pattern approving it enables (the host itself, or a `*.` pattern covering it). Thread metadata
 * only (the thread id, D28): never a prompt, URL or path. One pending request per (member,
 * pattern); approving or denying settles every pending request for the pattern.
 */
export const egressRequests = pgTable(
  "egress_requests",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    id: uuid().notNull().defaultRandom(),
    domain: text().notNull(),
    pattern: text().notNull(),
    requestedBy: uuid()
      .notNull()
      .references(() => users.id),
    /** The thread it was blocked in (the requester's own), if any. */
    threadId: uuid(),
    status: egressRequestStatus().notNull().default("pending"),
    decidedBy: uuid().references(() => users.id),
    decidedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    uniqueIndex("egress_requests_pending_key")
      .on(t.teamId, t.requestedBy, t.pattern)
      .where(sql`${t.status} = 'pending'`),
    index("egress_requests_team_status_idx").on(t.teamId, t.status, t.createdAt),
    check("egress_requests_domain", domainCheck(t.domain)),
    check("egress_requests_pattern", domainCheck(t.pattern)),
    check(
      "egress_requests_decided",
      sql`(${t.status} = 'pending') = (${t.decidedAt} IS NULL) AND (${t.status} = 'pending' OR ${t.decidedBy} IS NOT NULL)`,
    ),
  ],
);

export const EGRESS_REQUEST_EVENTS = ["requested", "approved", "denied"] as const;
export type EgressRequestEvent = (typeof EGRESS_REQUEST_EVENTS)[number];

export const egressRequestNotificationStatus = pgEnum("egress_request_notification_status", [
  "pending",
  "sent",
  "failed",
  "skipped",
]);

/**
 * Durable email outbox for request access: `requested` → each active team admin, `approved` /
 * `denied` → the requester. Written in the transaction that creates or decides the request, so a
 * committed request always has its notifications queued; delivered with retry and backoff
 * (services/server/src/egress/request-notify.ts). Holds ids only; the message is rendered at
 * delivery. The in-app side is the team console's request list and the chat's notice.
 */
export const egressRequestNotifications = pgTable(
  "egress_request_notifications",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    id: uuid().notNull().defaultRandom(),
    requestId: uuid().notNull(),
    event: text().notNull(),
    recipientId: uuid()
      .notNull()
      .references(() => users.id),
    status: egressRequestNotificationStatus().notNull().default("pending"),
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Machine-readable failure code of the last attempt (never an SMTP response text). */
    lastError: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    foreignKey({
      columns: [t.teamId, t.requestId],
      foreignColumns: [egressRequests.teamId, egressRequests.id],
    }).onDelete("cascade"),
    index("egress_request_notifications_due_idx")
      .on(t.teamId, t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
    check(
      "egress_request_notifications_event",
      sql`${t.event} IN (${sql.raw(EGRESS_REQUEST_EVENTS.map((e) => `'${e}'`).join(", "))})`,
    ),
    check("egress_request_notifications_last_error", sql`char_length(${t.lastError}) <= 64`),
  ],
);
