import { sql } from "drizzle-orm";
import {
  bigint,
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
import { users } from "./auth.js";
import { runs } from "./runs.js";
import { teams } from "./teams.js";
import { threads } from "./threads.js";

// Files (KOBE-142 = 53b of KOBE-53): one table for user uploads and files the agent shares
// (KOBE-54 share_file), plus the per-team storage quota. Team tables: every key and foreign key
// includes team_id, so a cascade can never reach another team's rows. Content lives in S3
// (`files.blob_ref`, listed in `blob-refs.ts`), never in Postgres.

/** Where a file came from: a user's upload, or a file the agent shared from the sandbox. */
export const FILE_KIND_VALUES = ["upload", "shared"] as const;
export type FileKind = (typeof FILE_KIND_VALUES)[number];

/** `none`: not scanned (ClamAV off); `clean`: scanned; `rejected`: infected, never served. */
export const FILE_SCAN_STATUS_VALUES = ["none", "clean", "rejected"] as const;
export type FileScanStatus = (typeof FILE_SCAN_STATUS_VALUES)[number];

const teamRef = () =>
  uuid()
    .notNull()
    .references(() => teams.id, { onDelete: "cascade" });

/**
 * One stored file. `thread_id` is null for a file not (yet) in a thread. A threaded file goes with
 * its thread (ON DELETE CASCADE, as thread_entries and artifacts do): the retention purge queues
 * its `blob_ref` first (`BLOB_REF_COLUMNS`, `thread: true`), so store threaded objects under
 * `<prefix>teams/<team>/threads/<thread>/` (KOBE-18). `(team_id, tool_call_id)` makes a shared
 * file idempotent per tool call (null for uploads).
 */
export const files = pgTable(
  "files",
  {
    teamId: teamRef(),
    id: uuid().notNull().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    threadId: uuid(),
    kind: text().$type<FileKind>().notNull(),
    name: text().notNull(),
    sizeBytes: bigint({ mode: "number" }).notNull(),
    sha256: text().notNull(),
    mimeType: text().notNull(),
    blobRef: text().notNull(),
    scanStatus: text().$type<FileScanStatus>().notNull().default("none"),
    runId: uuid(),
    toolCallId: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    foreignKey({
      name: "files_thread_fk",
      columns: [t.teamId, t.threadId],
      foreignColumns: [threads.teamId, threads.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "files_run_fk",
      columns: [t.teamId, t.runId],
      foreignColumns: [runs.teamId, runs.id],
    }),
    uniqueIndex("files_tool_call_unique")
      .on(t.teamId, t.toolCallId)
      .where(sql`${t.toolCallId} IS NOT NULL`),
    // Retention looks blob keys up by (team, key) (BLOB_REF_COLUMNS thread: true).
    index("files_blob_ref_idx").on(t.teamId, t.blobRef),
    index("files_thread_idx").on(t.teamId, t.threadId, t.createdAt),
    // Quota usage: a user's / the team's bytes.
    index("files_user_idx").on(t.teamId, t.userId),
    check("files_kind", sql`${t.kind} IN ('upload', 'shared')`),
    check("files_scan_status", sql`${t.scanStatus} IN ('none', 'clean', 'rejected')`),
    check("files_name_length", sql`char_length(${t.name}) BETWEEN 1 AND 255`),
    check("files_size", sql`${t.sizeBytes} >= 0`),
    check("files_sha256", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * A team's storage limit for files. No row, or `max_bytes` null, = the install default (chart
 * value; resolved by the server). A table rather than a column on `teams` because `teams` has no
 * team RLS: team admins edit this under `withTeam()`, like `team_retention`.
 */
export const teamStorageQuotas = pgTable(
  "team_storage_quotas",
  {
    teamId: teamRef(),
    maxBytes: bigint({ mode: "number" }),
    updatedBy: uuid()
      .notNull()
      .references(() => users.id),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId] }),
    check("team_storage_quotas_max", sql`${t.maxBytes} IS NULL OR ${t.maxBytes} >= 0`),
  ],
);
