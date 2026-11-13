import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { projects } from "./projects.js";
import { MEMORY_PENDING_KINDS, type NotificationKind } from "./schedule-notifications.js";
import { teamMembers } from "./team-members.js";
import { teams } from "./teams.js";

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

/**
 * Team table (KOBE-645, v1.3 Semantic Memory SM22): pending objects waiting for a person's
 * decision, each owed one `memory.review.reminder` after 7 days. Sources (Workspace proposals
 * KOBE-397, Site proposals KOBE-403, readers' suggestions KOBE-652, To review candidates) register
 * one row per (object, recipient) when the object is created and settle (delete) its rows when it
 * is decided; one replica's sweep sends what is due and stamps `sent_at`, so each object reminds
 * each recipient once. The recipient must be a member: the row goes with the membership.
 */
export const memoryReminders = pgTable(
  "memory_reminders",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    id: uuid().notNull().defaultRandom(),
    /** The pending object (proposal, suggestion, Site proposal or learning pass). */
    objectId: uuid().notNull(),
    /** What it is: a `MEMORY_PENDING_KINDS` kind, or null for candidates waiting in To review. */
    relatedKind: text().$type<NotificationKind>(),
    userId: uuid().notNull(),
    /** Suggestions: the project whose notes they are for (the reminder's deep link). */
    projectId: uuid(),
    dueAt: timestamp({ withTimezone: true }).notNull(),
    /** Set when the reminder was sent (or rolled into a digest). */
    sentAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    foreignKey({
      name: "memory_reminders_member_fk",
      columns: [t.teamId, t.userId],
      foreignColumns: [teamMembers.teamId, teamMembers.userId],
    }).onDelete("cascade"),
    foreignKey({
      name: "memory_reminders_project_fk",
      columns: [t.teamId, t.projectId],
      foreignColumns: [projects.teamId, projects.id],
    }).onDelete("cascade"),
    uniqueIndex("memory_reminders_once").on(t.teamId, t.objectId, t.userId),
    // The cascading foreign keys' checks (a membership removed, a project deleted).
    index("memory_reminders_user_idx").on(t.teamId, t.userId),
    index("memory_reminders_project_idx")
      .on(t.teamId, t.projectId)
      .where(sql`${t.projectId} IS NOT NULL`),
    index("memory_reminders_due_idx")
      .on(t.teamId, t.dueAt)
      .where(sql`${t.sentAt} IS NULL`),
    check(
      "memory_reminders_kind",
      sql`${t.relatedKind} IS NULL OR ${t.relatedKind} IN (${list(MEMORY_PENDING_KINDS)})`,
    ),
    check(
      "memory_reminders_project",
      sql`(${t.projectId} IS NOT NULL) = (${t.relatedKind} IS NOT DISTINCT FROM 'memory.suggestion.received')`,
    ),
  ],
);
