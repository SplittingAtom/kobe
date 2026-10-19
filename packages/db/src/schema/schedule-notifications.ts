import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { registrySkills } from "./registry.js";
import { runs } from "./runs.js";
import { SCHEDULE_PAUSED_BY } from "./schedules.js";
import { teams } from "./teams.js";
import { threads } from "./threads.js";

// Scheduled-run notifications, their email outbox and skipped actions (KOBE-177, spec D32;
// contract: packages/protocol/src/notifications.ts). Team tables (schedules area). Rows that
// belong to a thread or run are removed with it by foreign-key cascade: a retention or Trash
// purge deletes the thread, and the legal-hold triggers on `threads` / `runs` (0033) refuse that
// delete while a hold covers it, so a hold also keeps these rows. No separate guard is needed.
// A schedule delete keeps the notifications (a held thread's run notifications must survive it):
// the foreign key to `schedules` is ON DELETE SET NULL (schedule_id), SQL-only, in 0089.
// New outbox: the existing ones (`budget_alert_emails`, `egress_request_notifications`) are tied
// to their own parents and recipients, so this one follows their shape for notifications.

export const NOTIFICATION_KINDS = [
  "schedule.run.succeeded",
  "schedule.run.failed",
  "schedule.run.interrupted",
  "schedule.run.skipped_actions",
  "schedule.paused",
  /** A Team admin blocked a catalog skill the member had added for themselves (KOBE-338). */
  "skill.member_add.blocked",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_EMAIL_STATUSES = ["pending", "sent", "failed", "skipped"] as const;
export type NotificationEmailStatus = (typeof NOTIFICATION_EMAIL_STATUSES)[number];

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

/** In-app notifications of one user: the bell and the unread badge. Ids and counts, no content. */
export const notifications = pgTable(
  "notifications",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    id: uuid().notNull().defaultRandom(),
    // Users are deactivated, never deleted; NO ACTION keeps a stray delete from erasing rows.
    userId: uuid()
      .notNull()
      .references(() => users.id),
    kind: text().$type<NotificationKind>().notNull(),
    /** Null once the schedule is deleted (the foreign key, SQL-only in 0089, sets it null). */
    scheduleId: uuid(),
    /** Null only for `schedule.paused`. */
    threadId: uuid(),
    runId: uuid(),
    skippedCount: integer(),
    /** `skill.member_add.blocked`: the catalog skill (a site row; catalog rows are never deleted). */
    skillId: uuid().references(() => registrySkills.id),
    pausedBy: text().$type<(typeof SCHEDULE_PAUSED_BY)[number]>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    foreignKey({
      name: "notifications_thread_fk",
      columns: [t.teamId, t.threadId],
      foreignColumns: [threads.teamId, threads.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "notifications_run_fk",
      columns: [t.teamId, t.runId],
      foreignColumns: [runs.teamId, runs.id],
    }).onDelete("cascade"),
    check("notifications_kind", sql`${t.kind} IN (${list(NOTIFICATION_KINDS)})`),
    // A run notification names its thread and run; a pause names neither and says who paused; a
    // skill notification names its catalog skill and no schedule, thread or run (KOBE-338).
    check(
      "notifications_shape",
      sql`(${t.kind} = 'schedule.paused' AND ${t.threadId} IS NULL AND ${t.runId} IS NULL AND ${t.pausedBy} IS NOT NULL AND ${t.skillId} IS NULL)
        OR (${t.kind} = 'skill.member_add.blocked' AND ${t.scheduleId} IS NULL AND ${t.threadId} IS NULL AND ${t.runId} IS NULL AND ${t.pausedBy} IS NULL AND ${t.skillId} IS NOT NULL)
        OR (${t.kind} NOT IN ('schedule.paused', 'skill.member_add.blocked') AND ${t.threadId} IS NOT NULL AND ${t.runId} IS NOT NULL AND ${t.pausedBy} IS NULL AND ${t.skillId} IS NULL)`,
    ),
    check("notifications_paused_by", sql`${t.pausedBy} IN (${list(SCHEDULE_PAUSED_BY)})`),
    check("notifications_skipped_count", sql`${t.skippedCount} >= 0`),
    // The notifier is at-least-once: one notification per run and kind.
    uniqueIndex("notifications_run_kind_uniq")
      .on(t.teamId, t.runId, t.kind)
      .where(sql`${t.runId} IS NOT NULL`),
    // A user's list, newest first, and the unread count behind the badge.
    index("notifications_user_idx").on(t.teamId, t.userId, t.createdAt.desc()),
    index("notifications_unread_idx")
      .on(t.teamId, t.userId)
      .where(sql`${t.readAt} IS NULL`),
    // Cascade checks from a thread or schedule delete.
    index("notifications_thread_idx")
      .on(t.teamId, t.threadId)
      .where(sql`${t.threadId} IS NOT NULL`),
    index("notifications_schedule_idx").on(t.teamId, t.scheduleId),
  ],
);

/**
 * Email outbox for notifications (`schedules.notify_email`): written with the notification,
 * delivered at least once, to the notification's `user_id`, with retry, backoff and a lease so replicas do not double-send. Holds
 * ids only; the message is rendered at delivery.
 */
export const notificationEmails = pgTable(
  "notification_emails",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    id: uuid().notNull().defaultRandom(),
    notificationId: uuid().notNull(),
    status: text().$type<NotificationEmailStatus>().notNull().default("pending"),
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** A delivering replica holds the row until this time; null = not leased. */
    leaseUntil: timestamp({ withTimezone: true }),
    /** Machine-readable failure code of the last attempt (never an SMTP response text). */
    lastError: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    foreignKey({
      name: "notification_emails_notification_fk",
      columns: [t.teamId, t.notificationId],
      foreignColumns: [notifications.teamId, notifications.id],
    }).onDelete("cascade"),
    uniqueIndex("notification_emails_once").on(t.teamId, t.notificationId),
    index("notification_emails_due_idx")
      .on(t.teamId, t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
    check("notification_emails_status", sql`${t.status} IN (${list(NOTIFICATION_EMAIL_STATUSES)})`),
    check("notification_emails_attempts", sql`${t.attempts} >= 0`),
    check(
      "notification_emails_error",
      sql`${t.lastError} IS NULL OR ${t.lastError} ~ '^[a-z0-9_]{1,64}$'`,
    ),
    check("notification_emails_sent", sql`(${t.status} = 'sent') = (${t.sentAt} IS NOT NULL)`),
  ],
);

/**
 * Tool calls a scheduled run did not execute (deny-don't-wait, D32): one row per run and tool
 * call. Name, risk class and policy reason code only, never input or output.
 */
export const runSkippedActions = pgTable(
  "run_skipped_actions",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    runId: uuid().notNull(),
    toolCallId: text().notNull(),
    tool: text().notNull(),
    riskClass: text().$type<"read" | "write" | "destructive">().notNull(),
    /** A `policyReasonCodeSchema` value (validated in the protocol; text here). */
    reason: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.runId, t.toolCallId] }),
    foreignKey({
      name: "run_skipped_actions_run_fk",
      columns: [t.teamId, t.runId],
      foreignColumns: [runs.teamId, runs.id],
    }).onDelete("cascade"),
    check("run_skipped_actions_tool_call", sql`char_length(${t.toolCallId}) BETWEEN 1 AND 200`),
    check("run_skipped_actions_tool", sql`char_length(${t.tool}) BETWEEN 1 AND 200`),
    check("run_skipped_actions_risk", sql`${t.riskClass} IN ('read', 'write', 'destructive')`),
    check("run_skipped_actions_reason", sql`${t.reason} ~ '^[a-z][a-z0-9_]{0,63}$'`),
  ],
);
