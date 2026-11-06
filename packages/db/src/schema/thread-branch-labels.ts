import { sql } from "drizzle-orm";
import { check, foreignKey, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { teams } from "./teams.js";
import { threadEntries, threads } from "./threads.js";

/**
 * Branch labels (KOBE-543, spec CT9): a short name on any node of a thread's conversation tree,
 * kept on the node's first entry. Written by the thread's owner only, read by every viewer of the
 * thread; never model context, never in Pi's session file, not audited. At most
 * `BRANCH_LABELS_MAX` (200) per thread, checked by the server under the thread's row lock. A fork
 * copies the labels of the copied path (same entry ids); purge removes them with the thread.
 *
 * SQL-only (`*_thread_branch_labels_rls.sql`): team isolation (ENABLE + FORCE RLS).
 */
export const threadBranchLabels = pgTable(
  "thread_branch_labels",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    threadId: uuid().notNull(),
    entryId: text().notNull(),
    label: text().notNull(),
    // Users are deactivated, never deleted; NO ACTION keeps a stray delete from erasing history.
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.threadId, t.entryId] }),
    foreignKey({
      name: "thread_branch_labels_thread_fk",
      columns: [t.teamId, t.threadId],
      foreignColumns: [threads.teamId, threads.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "thread_branch_labels_entry_fk",
      columns: [t.teamId, t.threadId, t.entryId],
      foreignColumns: [threadEntries.teamId, threadEntries.threadId, threadEntries.entryId],
    }).onDelete("cascade"),
    check(
      "thread_branch_labels_label",
      sql`char_length(btrim(${t.label})) BETWEEN 1 AND 60 AND ${t.label} = btrim(${t.label})`,
    ),
  ],
);
