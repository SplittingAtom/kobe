import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { teams } from "./teams.js";
import { threads } from "./threads.js";

/**
 * Workspace sync conflicts (KOBE-492): the sandbox's sync kept the member's version of `path` and
 * moved the agent's unsynced edit to `conflict_path`. One row per conflict the sandbox reported,
 * names and hashes only (never content). `thread_id` is the thread whose run last wrote the path
 * (null when none did); `run_id` that run while it exists (cleared when the run goes).
 *
 * - `agent_notified_at`: the thread's agent was told (a fenced note at its next run, or mid-run).
 * - `resolved_at` / `dismissed_at`: the member acted on the notice (deleted the copy, or dismissed
 *   it); the notice is shown while both are null.
 *
 * Retention: rows follow their thread (cascade on purge), are deleted with the member's workspace
 * on offboarding, and the insert trims the member's old rows (a per-member cap). RLS is SQL-only
 * (custom migration `*_workspace_sync_conflicts_rls.sql`), as is the run key (`ON DELETE SET NULL
 * (run_id)`, which drizzle cannot express).
 */
export const workspaceSyncConflicts = pgTable(
  "workspace_sync_conflicts",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    id: uuid().notNull().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    threadId: uuid(),
    runId: uuid(),
    path: text().notNull(),
    conflictPath: text().notNull(),
    memberSha256: text().notNull(),
    agentSha256: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    agentNotifiedAt: timestamp({ withTimezone: true }),
    resolvedAt: timestamp({ withTimezone: true }),
    dismissedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    foreignKey({
      name: "workspace_sync_conflicts_thread_fk",
      columns: [t.teamId, t.threadId],
      foreignColumns: [threads.teamId, threads.id],
    }).onDelete("cascade"),
    index("workspace_sync_conflicts_open_idx")
      .on(t.teamId, t.userId, t.threadId, t.createdAt)
      .where(sql`${t.resolvedAt} IS NULL AND ${t.dismissedAt} IS NULL`),
    index("workspace_sync_conflicts_member_idx").on(t.teamId, t.userId, t.createdAt),
    index("workspace_sync_conflicts_run_idx")
      .on(t.teamId, t.runId)
      .where(sql`${t.runId} IS NOT NULL`),
    check(
      "workspace_sync_conflicts_paths",
      sql`octet_length(${t.path}) BETWEEN 1 AND 1024 AND octet_length(${t.conflictPath}) BETWEEN 1 AND 1024`,
    ),
    check(
      "workspace_sync_conflicts_hashes",
      sql`${t.memberSha256} ~ '^[0-9a-f]{64}$' AND ${t.agentSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "workspace_sync_conflicts_run_thread",
      sql`${t.runId} IS NULL OR ${t.threadId} IS NOT NULL`,
    ),
  ],
);

export type WorkspaceSyncConflictRow = typeof workspaceSyncConflicts.$inferSelect;
