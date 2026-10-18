import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { teams } from "./teams.js";

// A legal hold's copy of where a moved workspace file was (KOBE-304, the KOBE-275 history pattern).
// A move tombstones the file's old path, and a tombstone keeps no content, so without this copy the
// old path's link to its content would be lost. The file browser's move writes one row per moved
// file, in the move's own transaction, only while a hold covers the member
// (`legal_hold_covers(team_id, user_id)` in the INSERT itself), and answers as usual: a hold is
// never refused or otherwise visible. Immutable; nothing in the API reads it; deleting it is
// refused while a hold covers the member; the retention pass purges it once none does. RLS, the
// legal-hold guard and the immutability trigger are SQL-only (custom migration
// `*_workspace_file_hold_history_rls.sql`). Like workspace_files, not readable under break-glass.

export const workspaceFileHoldHistory = pgTable(
  "workspace_file_hold_history",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    id: uuid().notNull().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    /** Where the file was, relative to /workspace (`workspace_files.path` rules). */
    path: text().notNull(),
    /** Where the move put it. */
    movedTo: text().notNull(),
    sha256: text().notNull(),
    /** The content's object key, as the manifest row had it (listed in BLOB_REF_COLUMNS). */
    blobKey: text().notNull(),
    size: bigint({ mode: "number" }).notNull(),
    mtimeMs: bigint({ mode: "number" }).notNull(),
    /** The manifest revision the file had at its old path. */
    fileRev: bigint({ mode: "number" }).notNull(),
    keptAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    // The release purge, offboarding and a custodian's lookup by member.
    index("workspace_file_hold_history_user_idx").on(t.teamId, t.userId),
    check(
      "workspace_file_hold_history_paths",
      sql`octet_length(${t.path}) BETWEEN 1 AND 1024 AND octet_length(${t.movedTo}) BETWEEN 1 AND 1024`,
    ),
    check(
      "workspace_file_hold_history_content",
      sql`${t.sha256} ~ '^[0-9a-f]{64}$' AND char_length(${t.blobKey}) BETWEEN 1 AND 1024`,
    ),
    check(
      "workspace_file_hold_history_numbers",
      sql`${t.size} >= 0 AND ${t.mtimeMs} >= 0 AND ${t.fileRev} > 0`,
    ),
  ],
);
