import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  type PgTableExtraConfigValue,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { teams } from "./teams.js";

// Conversations (spec D15, §5.4). Team tables: every key and foreign key includes team_id, so
// foreign-key checks and cascades (which bypass RLS) can never reach another team's rows. Other
// areas reference a thread as (team_id, thread_id) → threads (team_id, id) for the same reason.

export const threadStatus = pgEnum("thread_status", ["idle", "running", "interrupted"]);
export type ThreadStatus = (typeof threadStatus.enumValues)[number];

const teamRef = () =>
  uuid()
    .notNull()
    .references(() => teams.id, { onDelete: "cascade" });

/**
 * A conversation. `leaf_entry_id` marks the active branch of the entry tree. `agent_id`/
 * `agent_version` pin the agent version the thread started on (D19); the foreign key to agents and
 * `project_id`'s to projects arrive with those tables (KOBE-45/46, KOBE-57). Null agent = the
 * install default agent until then.
 */
export const threads = pgTable(
  "threads",
  {
    teamId: teamRef(),
    id: uuid().notNull().defaultRandom(),
    // Users are deactivated, never deleted; NO ACTION keeps a stray delete from erasing history.
    ownerUserId: uuid()
      .notNull()
      .references(() => users.id),
    projectId: uuid(),
    agentId: uuid(),
    agentVersion: integer(),
    title: text(),
    leafEntryId: text(),
    status: threadStatus().notNull().default("idle"),
    sharedToProject: boolean().notNull().default(false),
    deletedAt: timestamp({ withTimezone: true }),
    lastActivityAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Last allocated `thread_entries.seq`; maintained by a trigger, never written by the app. */
    lastEntrySeq: integer().notNull().default(0),
  },
  // Annotated: threads and thread_entries reference each other (leaf and thread foreign keys).
  (t): PgTableExtraConfigValue[] => [
    primaryKey({ columns: [t.teamId, t.id] }),
    foreignKey({
      name: "threads_leaf_entry_fk",
      columns: [t.teamId, t.id, t.leafEntryId],
      foreignColumns: [threadEntries.teamId, threadEntries.threadId, threadEntries.entryId],
    }),
    // Thread list (D9, §6.1): the owner's live threads by recent activity.
    index("threads_owner_activity_idx")
      .on(t.teamId, t.ownerUserId, t.lastActivityAt.desc())
      .where(sql`${t.deletedAt} IS NULL`),
    index("threads_project_activity_idx")
      .on(t.teamId, t.projectId, t.lastActivityAt.desc())
      .where(sql`${t.projectId} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    // Trash and the 30-day hard purge (D18).
    index("threads_deleted_idx")
      .on(t.teamId, t.deletedAt)
      .where(sql`${t.deletedAt} IS NOT NULL`),
    check(
      "threads_agent_pin",
      sql`(${t.agentId} IS NULL) = (${t.agentVersion} IS NULL) AND (${t.agentVersion} IS NULL OR ${t.agentVersion} > 0)`,
    ),
    check("threads_last_entry_seq", sql`${t.lastEntrySeq} >= 0`),
  ],
);

/**
 * Pi session format v3 entries, mirrored one-to-one (D15): `entry_id`/`parent_id` are Pi's ids,
 * `type` is Pi's entry type (message, compaction, context_edit, branch_summary, …; text, so a Pi
 * 1.0.x patch adding a type needs no migration). `seq` is the per-thread append order (for
 * rebuilding the JSONL); a trigger assigns it, like `run_events.seq`. Payloads over 64 KB go to S3
 * via `blob_ref`.
 */
export const threadEntries = pgTable(
  "thread_entries",
  {
    teamId: teamRef(),
    threadId: uuid().notNull(),
    entryId: text().notNull(),
    parentId: text(),
    seq: integer().notNull().default(0),
    type: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    blobRef: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    primaryKey({ columns: [t.teamId, t.threadId, t.entryId] }),
    foreignKey({
      name: "thread_entries_thread_fk",
      columns: [t.teamId, t.threadId],
      foreignColumns: [threads.teamId, threads.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "thread_entries_parent_fk",
      columns: [t.teamId, t.threadId, t.parentId],
      foreignColumns: [t.teamId, t.threadId, t.entryId],
    }),
    unique("thread_entries_seq_unique").on(t.teamId, t.threadId, t.seq),
    // Children of an entry (branch navigation) and the parent foreign key's delete checks.
    index("thread_entries_parent_idx").on(t.teamId, t.threadId, t.parentId),
    check("thread_entries_seq_positive", sql`${t.seq} > 0`),
    check("thread_entries_entry_id_length", sql`char_length(${t.entryId}) BETWEEN 1 AND 128`),
    check("thread_entries_type_nonempty", sql`${t.type} <> ''`),
  ],
);
