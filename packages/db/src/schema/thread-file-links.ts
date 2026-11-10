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
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { projects } from "./projects.js";
import { teams } from "./teams.js";
import { threads } from "./threads.js";

/** How a thread used a file (TFM1): `write` = wrote or changed it, `read` = only read it. */
export const THREAD_FILE_ACCESS_VALUES = ["read", "write"] as const;
export type ThreadFileAccess = (typeof THREAD_FILE_ACCESS_VALUES)[number];

/**
 * Thread–file links (KOBE-610, spec docs/specs/thread-file-map.md §3): which workspace files a
 * thread read or wrote. Recorded by the server only (TFM2): an allowed file tool call at the policy
 * decision, an attachment, a project commit from the thread; and once from stored tool calls
 * (backfill, TFM3). One row per (thread, owner or project, path, access); repeated use bumps
 * `last_at` and `count`.
 *
 * Exactly one of `owner_user_id` (a path in that member's own workspace, relative to `/workspace`)
 * and `project_id` (a path inside that project, without the `projects/<slug>/` mount prefix, so a
 * renamed slug keeps its links). `deleted_at` is set while the file is gone (kept, shown as deleted).
 *
 * SQL-only (`*_thread_file_links_rls.sql`): team isolation (ENABLE + FORCE RLS), and the triggers
 * that follow moves (`workspace_files.moved_to`, `workspace_moves`) and deletes (workspace and
 * project files) so every writer of those tables keeps the links current.
 */
export const threadFileLinks = pgTable(
  "thread_file_links",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    id: uuid().notNull().defaultRandom(),
    threadId: uuid().notNull(),
    // Users are deactivated, never deleted; NO ACTION keeps a stray delete from erasing history.
    ownerUserId: uuid().references(() => users.id),
    projectId: uuid(),
    path: text().notNull(),
    access: text().$type<ThreadFileAccess>().notNull(),
    firstAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    count: integer().notNull().default(1),
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    foreignKey({
      name: "thread_file_links_thread_fk",
      columns: [t.teamId, t.threadId],
      foreignColumns: [threads.teamId, threads.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "thread_file_links_project_fk",
      columns: [t.teamId, t.projectId],
      foreignColumns: [projects.teamId, projects.id],
    }).onDelete("cascade"),
    // The upsert key; also the per-thread read (leads with team, thread).
    unique("thread_file_links_key")
      .on(t.teamId, t.threadId, t.ownerUserId, t.projectId, t.path, t.access)
      .nullsNotDistinct(),
    // Per path (file-threads read, move and delete triggers).
    index("thread_file_links_owner_path_idx")
      .on(t.teamId, t.ownerUserId, t.path)
      .where(sql`${t.ownerUserId} IS NOT NULL`),
    index("thread_file_links_project_path_idx")
      .on(t.teamId, t.projectId, t.path)
      .where(sql`${t.projectId} IS NOT NULL`),
    check("thread_file_links_scope", sql`(${t.ownerUserId} IS NULL) <> (${t.projectId} IS NULL)`),
    check(
      "thread_file_links_path",
      sql`octet_length(${t.path}) BETWEEN 1 AND 1024 AND ${t.path} !~ '(^/|/$|//)'`,
    ),
    check("thread_file_links_access", sql`${t.access} IN ('read', 'write')`),
    check("thread_file_links_count", sql`${t.count} > 0 AND ${t.lastAt} >= ${t.firstAt}`),
  ],
);
