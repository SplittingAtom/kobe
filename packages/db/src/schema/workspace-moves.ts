import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { teams } from "./teams.js";

// The move journal of a workspace (KOBE-304): one row per file-browser move or rename, written in
// the move's own transaction. The sandbox agent replays the moves newer than its last pull as local
// renames (`GET moves?since=`), so a moved tree is never downloaded again and its unsynced edits,
// caches and never-synced files move with it. `rev` is the move's first manifest revision (its rows
// are rev .. rev + 2 * files - 1). `files` and `bytes` also meter the per-member move budget, and
// a retried move that already happened is recognised here. Rows older than the tombstone TTL go
// (the move transaction trims them); offboarding deletes them with the manifest. RLS is SQL-only
// (custom migration `*_workspace_moves_rls.sql`).

export const WORKSPACE_MOVE_TYPES = ["file", "dir"] as const;

export const workspaceMoves = pgTable(
  "workspace_moves",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    rev: bigint({ mode: "number" }).notNull(),
    fromPath: text().notNull(),
    toPath: text().notNull(),
    type: text().$type<(typeof WORKSPACE_MOVE_TYPES)[number]>().notNull(),
    files: integer().notNull(),
    bytes: bigint({ mode: "number" }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId, t.rev] }),
    check(
      "workspace_moves_paths",
      sql`octet_length(${t.fromPath}) BETWEEN 1 AND 1024 AND octet_length(${t.toPath}) BETWEEN 1 AND 1024`,
    ),
    check("workspace_moves_type", sql`${t.type} IN ('file', 'dir')`),
    check("workspace_moves_numbers", sql`${t.rev} > 0 AND ${t.files} > 0 AND ${t.bytes} >= 0`),
  ],
);
