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
import { projects } from "./projects.js";
import { registrySkills } from "./registry.js";
import { runs } from "./runs.js";
import { SCHEDULE_PAUSED_BY } from "./schedules.js";
import { teamRole } from "./team-members.js";
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
  /** A catalog skill or version the team installed (or the member added) was retired (KOBE-340). */
  "skill.deprecated",
  "skill.version.deprecated",
  "skill.version.withdrawn",
  "skill.version.revoked",
  "skill.version.unrevoked",
  /** A Site admin published a new version of a team-published catalog skill (KOBE-495). */
  "skill.version.site_published",
  /** A Site admin added the user to the team from the Site console (KOBE-638). */
  "team.member.added",
  /**
   * A Site admin changed the team's membership from the Site console (KOBE-638 review M1): told
   * to the team's active team admins, naming the admin (`actor_user_id`), the member
   * (`subject_user_id`) and the team role (`team_role`: the new one, or the one removed).
   */
  "team.site_admin.member_added",
  "team.site_admin.member_role_changed",
  "team.site_admin.member_removed",
  "team.site_admin.member_taken_over",
  /**
   * Semantic memory (v1.3, KOBE-645): every phase's kinds at once, so later phases need no CHECK
   * change. Same names and order as `MEMORY_NOTIFICATION_KINDS` in @kobe/protocol (a server test
   * compares them). Columns: `memory_scope` (near_full), `memory_object_id` (the proposal,
   * suggestion or Site proposal; a reminder's pending object), `related_kind` (what a digest
   * rolls up or a reminder is about), `item_count`, `project_id` (suggestions).
   */
  "memory.scope.near_full",
  "memory.review.reminder",
  "memory.review.digest",
  "memory.review.candidates_ready",
  "memory.proposal.received",
  "memory.proposal.accepted",
  "memory.proposal.dismissed",
  "memory.proposal.changes_requested",
  "memory.proposal.expired",
  "memory.suggestion.received",
  "memory.suggestion.accepted",
  "memory.suggestion.dismissed",
  "memory.suggestion.expired",
  "memory.site_proposal.received",
  "memory.site_proposal.confirmed",
  "memory.site_proposal.changes_requested",
  "memory.site_proposal.accepted",
  "memory.site_proposal.dismissed",
  "memory.site_proposal.expired",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** The memory kinds (KOBE-645). */
export const MEMORY_NOTIFICATION_KINDS_DB = NOTIFICATION_KINDS.filter((k) =>
  k.startsWith("memory."),
);
/**
 * Memory kinds of an object waiting for someone's decision (a reminder may be about these): a
 * Site proposal waits for its Team admin (received, changes_requested) or the Site (confirmed).
 */
export const MEMORY_PENDING_KINDS = [
  "memory.proposal.received",
  "memory.suggestion.received",
  "memory.site_proposal.received",
  "memory.site_proposal.confirmed",
  "memory.site_proposal.changes_requested",
] as const satisfies readonly NotificationKind[];
/** Memory kinds about one proposal, suggestion or Site proposal (they name it). */
export const MEMORY_OBJECT_KINDS = NOTIFICATION_KINDS.filter((k) =>
  /^memory\.(proposal|suggestion|site_proposal)\./.test(k),
);
/** Scopes a `memory.scope.near_full` names: the shared ones with an item cap and curators. */
export const MEMORY_NEAR_FULL_SCOPES = ["team", "site"] as const;

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
    /** `skill.version.*`: the version retired (KOBE-340). */
    skillSemver: text(),
    pausedBy: text().$type<(typeof SCHEDULE_PAUSED_BY)[number]>(),
    /**
     * `skill.version.site_published`: the Site admin who published it (KOBE-495);
     * `team.member.added`: the Site admin who added the user (KOBE-638).
     */
    actorUserId: uuid().references(() => users.id),
    /** `team.site_admin.*`: the member the Site admin's change was about (KOBE-638 review M1). */
    subjectUserId: uuid().references(() => users.id),
    /** `team.site_admin.*`: the member's new team role, or the one they had when removed. */
    teamRole: teamRole(),
    /** `memory.scope.near_full`: the scope that reached 80% of its item cap (KOBE-645, SM22). */
    memoryScope: text().$type<(typeof MEMORY_NEAR_FULL_SCOPES)[number]>(),
    /**
     * `memory.proposal.*`, `memory.suggestion.*`, `memory.site_proposal.*`: the object; a
     * `memory.review.reminder`: the pending object. No foreign key: the source tables arrive in
     * later phases (KOBE-397, KOBE-403, KOBE-652) and delete their notifications themselves.
     */
    memoryObjectId: uuid(),
    /**
     * `memory.review.digest`: the kind it rolls up; `memory.review.reminder`: the kind of the
     * pending object (a `*.received`), or null for candidates waiting in To review.
     */
    relatedKind: text().$type<NotificationKind>(),
    /** `memory.review.digest`: how many it rolled up; `candidates_ready`: how many wait. */
    itemCount: integer(),
    /** `memory.suggestion.*` (and a reminder about one): the project whose notes it is for. */
    projectId: uuid(),
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
    foreignKey({
      name: "notifications_project_fk",
      columns: [t.teamId, t.projectId],
      foreignColumns: [projects.teamId, projects.id],
    }).onDelete("cascade"),
    check("notifications_kind", sql`${t.kind} IN (${list(NOTIFICATION_KINDS)})`),
    // A run notification names its thread and run; a pause names neither and says who paused; a
    // skill notification (KOBE-338, KOBE-340) names its catalog skill and no schedule, thread or
    // run, and a version one its version too; a team notification (KOBE-638) and a memory one
    // (KOBE-645) name none of them, except that candidates_ready names its thread.
    check(
      "notifications_shape",
      sql`(${t.kind} = 'schedule.paused' AND ${t.threadId} IS NULL AND ${t.runId} IS NULL AND ${t.pausedBy} IS NOT NULL AND ${t.skillId} IS NULL AND ${t.skillSemver} IS NULL)
        OR (${t.kind} LIKE 'team.%' AND ${t.scheduleId} IS NULL AND ${t.threadId} IS NULL AND ${t.runId} IS NULL AND ${t.pausedBy} IS NULL AND ${t.skillId} IS NULL AND ${t.skillSemver} IS NULL)
        OR (${t.kind} LIKE 'skill.%' AND ${t.scheduleId} IS NULL AND ${t.threadId} IS NULL AND ${t.runId} IS NULL AND ${t.pausedBy} IS NULL AND ${t.skillId} IS NOT NULL
          AND (${t.skillSemver} IS NOT NULL) = (${t.kind} LIKE 'skill.version.%'))
        OR (${t.kind} LIKE 'memory.%' AND ${t.scheduleId} IS NULL AND (${t.threadId} IS NULL OR ${t.kind} = 'memory.review.candidates_ready') AND ${t.runId} IS NULL AND ${t.pausedBy} IS NULL AND ${t.skillId} IS NULL AND ${t.skillSemver} IS NULL)
        OR (${t.kind} <> 'schedule.paused' AND ${t.kind} NOT LIKE 'skill.%' AND ${t.kind} NOT LIKE 'team.%' AND ${t.kind} NOT LIKE 'memory.%' AND ${t.threadId} IS NOT NULL AND ${t.runId} IS NOT NULL AND ${t.pausedBy} IS NULL AND ${t.skillId} IS NULL AND ${t.skillSemver} IS NULL)`,
    ),
    check(
      "notifications_skill_semver",
      sql`${t.skillSemver} IS NULL OR char_length(${t.skillSemver}) BETWEEN 5 AND 32`,
    ),
    check("notifications_paused_by", sql`${t.pausedBy} IN (${list(SCHEDULE_PAUSED_BY)})`),
    check(
      "notifications_actor",
      sql`(${t.kind} = 'skill.version.site_published' OR ${t.kind} LIKE 'team.%') = (${t.actorUserId} IS NOT NULL)
        OR (${t.kind} IN (${list(MEMORY_OBJECT_KINDS)}))`,
    ),
    // Memory kinds (KOBE-645): what each names. A proposal, suggestion or Site proposal names its
    // object (a suggestion its project too) and may name who acted (`actor_user_id`); a reminder
    // names its pending object and what it is (null: To review candidates); a digest names the kind
    // it rolls up and how many; candidates_ready its thread, how many wait and optionally the pass
    // (`memory_object_id`); near_full names the scope. Nothing else carries these columns.
    // COALESCE: a null in an IN list would otherwise make the check pass.
    check(
      "notifications_memory",
      sql`COALESCE((${t.kind} NOT LIKE 'memory.%' AND ${t.memoryScope} IS NULL AND ${t.memoryObjectId} IS NULL AND ${t.relatedKind} IS NULL AND ${t.itemCount} IS NULL AND ${t.projectId} IS NULL)
        OR (${t.kind} = 'memory.scope.near_full' AND ${t.memoryScope} IN (${list(MEMORY_NEAR_FULL_SCOPES)}) AND ${t.memoryObjectId} IS NULL AND ${t.relatedKind} IS NULL AND ${t.itemCount} IS NULL AND ${t.projectId} IS NULL AND ${t.actorUserId} IS NULL)
        OR (${t.kind} = 'memory.review.candidates_ready' AND ${t.threadId} IS NOT NULL AND ${t.itemCount} >= 1 AND ${t.memoryScope} IS NULL AND ${t.relatedKind} IS NULL AND ${t.projectId} IS NULL AND ${t.actorUserId} IS NULL)
        OR (${t.kind} = 'memory.review.digest' AND ${t.relatedKind} IN (${list(MEMORY_NOTIFICATION_KINDS_DB.filter((k) => k !== "memory.review.digest"))}) AND ${t.itemCount} >= 1 AND ${t.memoryScope} IS NULL AND ${t.memoryObjectId} IS NULL AND ${t.projectId} IS NULL AND ${t.actorUserId} IS NULL)
        OR (${t.kind} = 'memory.review.reminder' AND ${t.memoryObjectId} IS NOT NULL AND (${t.relatedKind} IS NULL OR ${t.relatedKind} IN (${list(MEMORY_PENDING_KINDS)})) AND (${t.projectId} IS NOT NULL) = (${t.relatedKind} IS NOT DISTINCT FROM 'memory.suggestion.received') AND ${t.memoryScope} IS NULL AND ${t.itemCount} IS NULL AND ${t.actorUserId} IS NULL)
        OR (${t.kind} IN (${list(MEMORY_OBJECT_KINDS)}) AND ${t.memoryObjectId} IS NOT NULL AND (${t.projectId} IS NOT NULL) = (${t.kind} LIKE 'memory.suggestion.%') AND ${t.memoryScope} IS NULL AND ${t.relatedKind} IS NULL AND ${t.itemCount} IS NULL), false)`,
    ),
    check(
      "notifications_subject",
      sql`(${t.kind} LIKE 'team.site_admin.%') = (${t.subjectUserId} IS NOT NULL)
        AND (${t.teamRole} IS NULL OR ${t.kind} LIKE 'team.site_admin.%')`,
    ),
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
    // The digest's count of one recipient's recent notifications of one kind (KOBE-645).
    index("notifications_memory_recent_idx")
      .on(t.teamId, t.userId, t.kind, t.createdAt)
      .where(sql`${t.kind} LIKE 'memory.%'`),
    // Cascade checks from a project delete.
    index("notifications_project_idx")
      .on(t.teamId, t.projectId)
      .where(sql`${t.projectId} IS NOT NULL`),
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
