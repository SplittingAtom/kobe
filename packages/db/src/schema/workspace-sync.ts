import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { teams } from "./teams.js";

// Workspace sync (KOBE-27, spec D12, D13, D15, D26): the durable copy of each (team, user)
// sandbox's /workspace in S3. Postgres is the record of what is there (the manifest); S3 holds
// content-addressed blobs. Contract: packages/protocol sandbox-wire/workspace-sync.ts.

export const workspaceFileOrigin = pgEnum("workspace_file_origin", ["sandbox", "server"]);

/** One workspace per (team, user): its revision counter and totals (quota seam, KOBE-53). */
export const workspaceSync = pgTable(
  "workspace_sync",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    /** Last revision handed out; every manifest change takes the next one (row lock). */
    headRev: bigint({ mode: "number" }).notNull().default(0),
    /** Tombstones at or below this revision were purged: `since` below it must resync from 0. */
    horizonRev: bigint({ mode: "number" }).notNull().default(0),
    liveFiles: integer().notNull().default(0),
    liveBytes: bigint({ mode: "number" }).notNull().default(0),
    /** Tombstone rows: live + tombstones is capped per workspace (rows, not just files). */
    tombstones: integer().notNull().default(0),
    /** Rows and bytes in `workspace_blobs` (committed or not): caps uncommitted uploads. */
    blobCount: integer().notNull().default(0),
    blobBytes: bigint({ mode: "number" }).notNull().default(0),
    /** Uploads in flight, reserved before their bytes are accepted (quota without a race). */
    pendingBlobs: integer().notNull().default(0),
    pendingBytes: bigint({ mode: "number" }).notNull().default(0),
    /** When the oldest outstanding reservation was taken (stale ones are cleared by collection). */
    pendingSince: timestamp({ withTimezone: true }),
    lastPushAt: timestamp({ withTimezone: true }),
    lastRestoreAt: timestamp({ withTimezone: true }),
    lastRestoreMs: integer(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId] }),
    check(
      "workspace_sync_counts",
      sql`${t.liveFiles} >= 0 AND ${t.liveBytes} >= 0 AND ${t.tombstones} >= 0 AND ${t.blobCount} >= 0 AND ${t.blobBytes} >= 0 AND ${t.pendingBlobs} >= 0 AND ${t.pendingBytes} >= 0`,
    ),
    check("workspace_sync_horizon", sql`${t.horizonRev} BETWEEN 0 AND ${t.headRev}`),
  ],
);

/** The manifest: one row per path (live or tombstone). */
export const workspaceFiles = pgTable(
  "workspace_files",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    /** Relative to /workspace (protocol `workspacePathIssue` rules). */
    path: text().notNull(),
    rev: bigint({ mode: "number" }).notNull(),
    deleted: boolean().notNull().default(false),
    /** Null for tombstones. */
    sha256: text(),
    /** Object key of the content (null for tombstones). Sandbox pushes: the workspace's own blob
     *  prefix; server writes (KOBE-53 uploads, KOBE-57 projects) may point at their own keys. */
    blobKey: text(),
    size: bigint({ mode: "number" }).notNull(),
    mtimeMs: bigint({ mode: "number" }).notNull(),
    executable: boolean().notNull().default(false),
    origin: workspaceFileOrigin().notNull(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId, t.path] }),
    // Incremental pulls: changes since a revision, in order.
    index("workspace_files_rev_idx").on(t.teamId, t.userId, t.rev),
    // Collection: is a blob still referenced?
    index("workspace_files_sha_idx")
      .on(t.teamId, t.userId, t.sha256)
      .where(sql`NOT ${t.deleted}`),
    check(
      "workspace_files_path",
      sql`octet_length(${t.path}) BETWEEN 1 AND 1024 AND ${t.path} !~ '(^/|^\\.\\./|/\\.\\./|/\\.\\.$|^\\.\\.$|//)'`,
    ),
    check(
      "workspace_files_content",
      sql`(${t.deleted} AND ${t.sha256} IS NULL AND ${t.blobKey} IS NULL) OR (NOT ${t.deleted} AND ${t.sha256} ~ '^[0-9a-f]{64}$' AND char_length(${t.blobKey}) BETWEEN 1 AND 1024)`,
    ),
    check("workspace_files_numbers", sql`${t.rev} > 0 AND ${t.size} >= 0 AND ${t.mtimeMs} >= 0`),
  ],
);

/** Blobs uploaded into a workspace's own prefix (`teams/<t>/users/<u>/workspace/<sha256>`). */
export const workspaceBlobs = pgTable(
  "workspace_blobs",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    sha256: text().notNull(),
    size: bigint({ mode: "number" }).notNull(),
    /**
     * Collection in progress: the row is kept until its object is gone, and an upload of the same
     * content waits for it (the object may be deleted any moment).
     */
    deleting: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Last time a manifest row stopped pointing at this content: collection grace runs from it. */
    releasedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId, t.sha256] }),
    check("workspace_blobs_sha", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check("workspace_blobs_size", sql`${t.size} >= 0`),
  ],
);
