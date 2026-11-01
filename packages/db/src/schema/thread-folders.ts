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
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { teams } from "./teams.js";

/**
 * Thread folders (KOBE-534, spec TF1): the team's folders, seen and changed by every member (no
 * owner; `created_by` is for the audit trail). Nested at most three levels deep
 * (`THREAD_FOLDER_MAX_DEPTH`, counting the folder itself), at most 500 per team
 * (`THREAD_FOLDERS_MAX`, checked by the server under a per-team advisory lock). A thread names its
 * folder in `threads.folder_id` (TF2).
 *
 * SQL-only (`*_thread_folders_rls.sql`): team isolation (ENABLE + FORCE RLS); the sibling-name
 * key `thread_folders_name_unique` on (team_id, parent_id, lower(name)) NULLS NOT DISTINCT (so
 * top-level names are unique too); and trigger `thread_folders_guard_parent`, which refuses a
 * parent chain deeper than three (also when a moved folder's subtree would end up deeper) and any
 * cycle. Deleting a folder cascades to its subfolders; their threads' `folder_id` is nulled.
 */
export const threadFolders = pgTable(
  "thread_folders",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    id: uuid().notNull().defaultRandom(),
    /** Null = a top-level folder. */
    parentId: uuid(),
    name: text().notNull(),
    /** Manual order among siblings; ties by name. */
    position: integer().notNull().default(0),
    // Users are deactivated, never deleted; NO ACTION keeps a stray delete from erasing history.
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    foreignKey({
      name: "thread_folders_parent_fk",
      columns: [t.teamId, t.parentId],
      foreignColumns: [t.teamId, t.id],
    }).onDelete("cascade"),
    index("thread_folders_tree_idx").on(t.teamId, t.parentId, t.position, t.name),
    check(
      "thread_folders_name",
      sql`char_length(btrim(${t.name})) BETWEEN 1 AND 80 AND ${t.name} = btrim(${t.name})`,
    ),
  ],
);
