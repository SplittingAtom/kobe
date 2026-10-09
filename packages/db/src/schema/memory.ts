import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { projects } from "./projects.js";
import { teams } from "./teams.js";

// File memory (KOBE-154 = 56b of KOBE-56, spec D24; contract: packages/protocol/src/memory.ts).
// Team tables: every key and foreign key includes team_id. Content lives in S3
// (`memory_doc_versions.blob_ref`, listed in `blob-refs.ts`), never in Postgres.

/** `user`: personal memory per (user, team); `project`: shared by a project's members. */
export const MEMORY_SCOPE_VALUES = ["user", "project"] as const;
export type MemoryScope = (typeof MEMORY_SCOPE_VALUES)[number];

/** Who wrote a version: a person (panel, personal `remember`) or the agent. */
export const MEMORY_ACTOR_KIND_VALUES = ["user", "agent"] as const;
export type MemoryActorKind = (typeof MEMORY_ACTOR_KIND_VALUES)[number];

/** Largest file (protocol `MEMORY_FILE_MAX_BYTES`, 64 KiB). */
export const MEMORY_FILE_MAX_BYTES = 64 * 1024;

/**
 * Install setting (`install_settings`) holding the install-wide memory switch: `false` turns
 * memory off for every team; absent or anything else = on. Effective = install AND team (D24).
 */
export const MEMORY_INSTALL_ENABLED_KEY = "memory.enabled";

// Mirrors protocol `memoryPathSchema`: relative `.md`, 1-4 segments of [A-Za-z0-9][A-Za-z0-9._-]*,
// max 200 chars, no `..` segment (the segment pattern also refuses empty and dot-led segments;
// the explicit `..` check covers `a..b.md`, which the protocol also refuses).
const PATH_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*){0,3}\\.md$";

const teamRef = () =>
  uuid()
    .notNull()
    .references(() => teams.id, { onDelete: "cascade" });

/**
 * One memory file. `scope = 'user'`: `owner_user_id` set, `project_id` null (personal, per user
 * and team). `scope = 'project'`: `project_id` set, `owner_user_id` null. `project_id` → `projects`
 * (KOBE-160) is ON DELETE RESTRICT: project memory is shared content under
 * legal hold and retention, so deleting a project must first delete its docs deliberately (the
 * hold guard then decides), never cascade.
 * `current_version` is the newest row of `memory_doc_versions`; `deleted_at` is a soft delete
 * (the panel's delete, restorable by Undo), so history stays. A path is unique per owner (user
 * scope) or project (project scope), deleted or not: re-creating a deleted path revives the row.
 */
export const memoryDocs = pgTable(
  "memory_docs",
  {
    teamId: teamRef(),
    id: uuid().notNull().defaultRandom(),
    scope: text().$type<MemoryScope>().notNull(),
    ownerUserId: uuid().references(() => users.id),
    projectId: uuid(),
    path: text().notNull(),
    currentVersion: integer().notNull().default(1),
    deletedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    uniqueIndex("memory_docs_user_path_unique")
      .on(t.teamId, t.ownerUserId, t.path)
      .where(sql`${t.scope} = 'user'`),
    uniqueIndex("memory_docs_project_path_unique")
      .on(t.teamId, t.projectId, t.path)
      .where(sql`${t.scope} = 'project'`),
    foreignKey({
      name: "memory_docs_project_fk",
      columns: [t.teamId, t.projectId],
      foreignColumns: [projects.teamId, projects.id],
    }).onDelete("restrict"),
    check("memory_docs_scope", sql`${t.scope} IN ('user', 'project')`),
    check(
      "memory_docs_scope_keys",
      sql`(${t.scope} = 'user' AND ${t.ownerUserId} IS NOT NULL AND ${t.projectId} IS NULL) OR (${t.scope} = 'project' AND ${t.ownerUserId} IS NULL AND ${t.projectId} IS NOT NULL)`,
    ),
    check(
      "memory_docs_path",
      sql`char_length(${t.path}) <= 200 AND ${t.path} ~ ${sql.raw(`'${PATH_PATTERN}'`)} AND position('..' in ${t.path}) = 0`,
    ),
    check("memory_docs_version", sql`${t.currentVersion} >= 1`),
  ],
);

/**
 * One immutable version of a memory file: history and Undo (restore = a new version copying an
 * earlier one). `blob_ref` is the S3 key, `<prefix>teams/<team>/memory/<doc>/<version>`: not a
 * thread tree, so the thread-retention purge never touches it. `run_id` and `tool_call_id` name
 * the agent's write (null for people); `run_id` has no foreign key so purging a run never
 * blocks on, or deletes, memory history.
 */
export const memoryDocVersions = pgTable(
  "memory_doc_versions",
  {
    teamId: teamRef(),
    docId: uuid().notNull(),
    version: integer().notNull(),
    blobRef: text().notNull(),
    sizeBytes: integer().notNull(),
    sha256: text().notNull(),
    actorKind: text().$type<MemoryActorKind>().notNull(),
    actorUserId: uuid().references(() => users.id),
    runId: uuid(),
    toolCallId: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.docId, t.version] }),
    foreignKey({
      name: "memory_doc_versions_doc_fk",
      columns: [t.teamId, t.docId],
      foreignColumns: [memoryDocs.teamId, memoryDocs.id],
    }).onDelete("cascade"),
    index("memory_doc_versions_blob_ref_idx").on(t.teamId, t.blobRef),
    check("memory_doc_versions_version", sql`${t.version} >= 1`),
    check(
      "memory_doc_versions_size",
      sql`${t.sizeBytes} BETWEEN 0 AND ${sql.raw(String(MEMORY_FILE_MAX_BYTES))}`,
    ),
    check("memory_doc_versions_sha256", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check("memory_doc_versions_actor", sql`${t.actorKind} IN ('user', 'agent')`),
  ],
);

/**
 * A team's memory switches (D24, team admins). No row = both on. Effective = this AND the
 * install switch (`MEMORY_INSTALL_ENABLED_KEY`); `project_memory_enabled` only matters while
 * `memory_enabled` is on. A table, not `teams.settings`: `teams` has no team RLS.
 */
export const teamMemorySettings = pgTable(
  "team_memory_settings",
  {
    teamId: teamRef(),
    memoryEnabled: boolean().notNull().default(true),
    projectMemoryEnabled: boolean().notNull().default(true),
    updatedBy: uuid()
      .notNull()
      .references(() => users.id),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.teamId] })],
);
