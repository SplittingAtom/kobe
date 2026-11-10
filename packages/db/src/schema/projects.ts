import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { teams } from "./teams.js";

// Projects (KOBE-160 = 57b of KOBE-57, spec D23; contract: packages/protocol/src/projects.ts).
// Team tables: every key and foreign key includes team_id. File content lives in S3
// (`project_files.blob_ref`, listed in `blob-refs.ts`), never in Postgres.

/**
 * Effective project roles (KOBE-577, Workspaces PR3; protocol `projectRoleSchema`): `owner` manages
 * the project and its people, `editor` checks out and commits, `reader` views and converses. Every
 * workspace member is at least a reader (KOBE-587, projects-in-conversations RV1), so `reader` is
 * never stored: explicit rows name owners and editors only ({@link PROJECT_MEMBER_ROLE_VALUES}).
 */
export const PROJECT_ROLE_VALUES = ["owner", "editor", "reader"] as const;
export type ProjectRole = (typeof PROJECT_ROLE_VALUES)[number];

/** Roles an explicit `project_members` row may hold (RV1; protocol `projectMemberRoleSchema`). */
export const PROJECT_MEMBER_ROLE_VALUES = ["owner", "editor"] as const;
export type ProjectMemberRole = (typeof PROJECT_MEMBER_ROLE_VALUES)[number];

/**
 * The retired project visibilities (Workspaces PR2, removed by KOBE-587): only audit rows written
 * before the removal name them (`project.created`, `project.visibility_changed`).
 */
export const PROJECT_VISIBILITY_VALUES = ["workspace", "restricted"] as const;
export type ProjectVisibility = (typeof PROJECT_VISIBILITY_VALUES)[number];

/** Who wrote a commit (CM1): a person (web, editor) or an agent's `commit_project` call. */
export const PROJECT_COMMIT_AUTHOR_KINDS = ["user", "agent"] as const;
export type ProjectCommitAuthorKind = (typeof PROJECT_COMMIT_AUTHOR_KINDS)[number];

/** Protocol `PROJECT_COMMIT_MESSAGE_MAX` (characters). */
export const PROJECT_COMMIT_MESSAGE_MAX = 500;
/** Protocol `PROJECT_FILES_MAX`: files per tree. */
export const PROJECT_TREE_FILES_MAX = 500;
/** Protocol `PROJECT_FILE_MAX_BYTES`. */
export const PROJECT_FILE_MAX_BYTES = 50 * 1024 * 1024;

/** `upload`: a person added it; `proposal`: an agent proposed it and an approval granted it. */
export const PROJECT_FILE_SOURCE_VALUES = ["upload", "proposal"] as const;
export type ProjectFileSource = (typeof PROJECT_FILE_SOURCE_VALUES)[number];

/** Protocol `PROJECT_INSTRUCTIONS_MAX_BYTES` (UTF-8 bytes, added to every thread's context). */
export const PROJECT_INSTRUCTIONS_MAX_BYTES = 8 * 1024;

const teamRef = () =>
  uuid()
    .notNull()
    .references(() => teams.id, { onDelete: "cascade" });

/**
 * A project inside a team. `slug` is unique per team and names the read-only mount folder
 * (`/workspace/projects/<slug>`); same pattern and length as the protocol. `instructions` is
 * capped at 8 KiB (bytes, as the protocol). `default_agent_id` has no foreign key: the agent may
 * be a team, personal or gallery agent (two tables), so the server validates it; null = the team
 * default. `archived_at` is the normal way to retire a project; a hard delete is refused while
 * threads or memory still point at it (see `threads.project_id`, `memory_docs.project_id`).
 */
export const projects = pgTable(
  "projects",
  {
    teamId: teamRef(),
    id: uuid().notNull().defaultRandom(),
    slug: text().notNull(),
    name: text().notNull(),
    description: text().notNull().default(""),
    instructions: text().notNull().default(""),
    defaultAgentId: uuid(),
    /**
     * The current commit (CM1): `project_files` is its tree. Null until the first commit. The
     * SQL-only key (team_id, id, head_commit_id) -> project_commits (team_id, project_id, id) refuses deleting the head (GV3
     * pruning never may).
     */
    headCommitId: uuid(),
    /**
     * Storage attributed to the project (GV2), kept by the server with every commit and prune:
     * `live_*` = the head tree (`project_files`), `history_*` = the distinct blobs that only older
     * commits still reference (so live + history = what the project holds in the object store).
     */
    liveBytes: bigint({ mode: "number" }).notNull().default(0),
    liveObjects: integer().notNull().default(0),
    historyBytes: bigint({ mode: "number" }).notNull().default(0),
    historyObjects: integer().notNull().default(0),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    uniqueIndex("projects_slug_unique").on(t.teamId, t.slug),
    index("projects_team_active_idx")
      .on(t.teamId, t.name)
      .where(sql`${t.archivedAt} IS NULL`),
    check(
      "projects_slug",
      sql`char_length(${t.slug}) <= 40 AND ${t.slug} ~ '^[a-z0-9][a-z0-9-]*$'`,
    ),
    check("projects_name", sql`char_length(btrim(${t.name})) BETWEEN 1 AND 100`),
    check("projects_description", sql`char_length(${t.description}) <= 500`),
    check(
      "projects_instructions",
      sql`octet_length(${t.instructions}) <= ${sql.raw(String(PROJECT_INSTRUCTIONS_MAX_BYTES))}`,
    ),
    check(
      "projects_storage_counts",
      sql`${t.liveBytes} >= 0 AND ${t.liveObjects} >= 0 AND ${t.historyBytes} >= 0 AND ${t.historyObjects} >= 0`,
    ),
    // projects_head_commit_fk (team_id, id, head_commit_id) -> project_commits is SQL-only
    // (`0200_workspaces_rls.sql`): drizzle cannot type a key between two tables that point at
    // each other.
  ],
);

/**
 * Explicit project members (PR3, RV1): owners and editors only; every other workspace member is an
 * implicit reader (KOBE-587 removed restricted visibility and the reader rows). "The last owner
 * stays" is a server rule. Removing a project removes its member rows.
 */
export const projectMembers = pgTable(
  "project_members",
  {
    teamId: teamRef(),
    projectId: uuid().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    role: text().$type<ProjectMemberRole>().notNull().default("editor"),
    addedBy: uuid()
      .notNull()
      .references(() => users.id),
    addedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.projectId, t.userId] }),
    foreignKey({
      name: "project_members_project_fk",
      columns: [t.teamId, t.projectId],
      foreignColumns: [projects.teamId, projects.id],
    }).onDelete("cascade"),
    // "Which projects is this user in" (a member's explicit roles).
    index("project_members_user_idx").on(t.teamId, t.userId),
    check("project_members_role", sql`${t.role} IN ('owner', 'editor')`),
  ],
);

/**
 * One file of a project, synced read-only to `/workspace/projects/<slug>/<path>`. `path` is
 * relative to the project folder, `/`-separated, unique per project (same name and folder =
 * `already_exists`). `blob_ref` is the S3 key, suggested
 * `<prefix>teams/<team>/projects/<project>/files/<id>`: not a thread tree, so the thread purge
 * never touches it. A project's files go with the project (ON DELETE CASCADE); the legal-hold
 * guard refuses that while a hold covers the team, and the feature PR queues the blobs first.
 */
export const projectFiles = pgTable(
  "project_files",
  {
    teamId: teamRef(),
    id: uuid().notNull().defaultRandom(),
    projectId: uuid().notNull(),
    path: text().notNull(),
    sizeBytes: bigint({ mode: "number" }).notNull(),
    sha256: text().notNull(),
    mimeType: text().notNull(),
    blobRef: text().notNull(),
    source: text().$type<ProjectFileSource>().notNull().default("upload"),
    addedBy: uuid()
      .notNull()
      .references(() => users.id),
    addedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    foreignKey({
      name: "project_files_project_fk",
      columns: [t.teamId, t.projectId],
      foreignColumns: [projects.teamId, projects.id],
    }).onDelete("cascade"),
    uniqueIndex("project_files_path_unique").on(t.teamId, t.projectId, t.path),
    index("project_files_blob_ref_idx").on(t.teamId, t.blobRef),
    check(
      "project_files_path",
      sql`char_length(${t.path}) BETWEEN 1 AND 1024 AND ${t.path} !~ '(^/|//|/$|\\\\)' AND ${t.path} !~ '(^|/)\\.\\.?(/|$)'`,
    ),
    check(
      "project_files_size",
      sql`${t.sizeBytes} BETWEEN 0 AND ${sql.raw(String(50 * 1024 * 1024))}`,
    ),
    check("project_files_sha256", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check("project_files_source", sql`${t.source} IN ('upload', 'proposal')`),
  ],
);

/**
 * One commit of a project (KOBE-577, Workspaces CM1). `seq` counts 1, 2, 3... per project
 * (assigned under the project row lock); `parent_id` is the previous head, null for the first and
 * cleared when pruning (GV3) removes the parent (SQL-only key with `ON DELETE SET NULL
 * (parent_id)`, `0200_workspaces_rls.sql`). `author_user_id` is the member who committed, or whose
 * conversation's agent did (`author_kind agent`, with `thread_id`/`run_id`; both keys SQL-only and
 * cleared when the thread or run is purged: history outlives its conversation). `file_count` and
 * `bytes` describe the commit's whole tree. History is append-only: a revert is a new commit.
 */
export const projectCommits = pgTable(
  "project_commits",
  {
    teamId: teamRef(),
    id: uuid().notNull().defaultRandom(),
    projectId: uuid().notNull(),
    seq: integer().notNull(),
    parentId: uuid(),
    authorUserId: uuid()
      .notNull()
      .references(() => users.id),
    authorKind: text().$type<ProjectCommitAuthorKind>().notNull(),
    threadId: uuid(),
    runId: uuid(),
    message: text().notNull(),
    fileCount: integer().notNull(),
    bytes: bigint({ mode: "number" }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    foreignKey({
      name: "project_commits_project_fk",
      columns: [t.teamId, t.projectId],
      foreignColumns: [projects.teamId, projects.id],
    }).onDelete("cascade"),
    // The target of every same-project pointer (head, parent, checkout base): a key that includes
    // project_id, so none of them can name another project's commit.
    unique("project_commits_project_commit_unique").on(t.teamId, t.projectId, t.id),
    // One seq per project; also the history page (newest first) and "head's seq" lookups.
    uniqueIndex("project_commits_seq_unique").on(t.teamId, t.projectId, t.seq.desc()),
    // The SQL-only SET NULL keys look these up when a thread or run is purged.
    index("project_commits_thread_idx")
      .on(t.teamId, t.threadId)
      .where(sql`${t.threadId} IS NOT NULL`),
    index("project_commits_run_idx")
      .on(t.teamId, t.runId)
      .where(sql`${t.runId} IS NOT NULL`),
    index("project_commits_parent_idx")
      .on(t.teamId, t.parentId)
      .where(sql`${t.parentId} IS NOT NULL`),
    check("project_commits_seq", sql`${t.seq} >= 1`),
    check("project_commits_parent", sql`${t.parentId} IS DISTINCT FROM ${t.id}`),
    check("project_commits_author_kind", sql`${t.authorKind} IN ('user', 'agent')`),
    check(
      "project_commits_message",
      sql`char_length(btrim(${t.message})) BETWEEN 1 AND ${sql.raw(String(PROJECT_COMMIT_MESSAGE_MAX))}`,
    ),
    check(
      "project_commits_counts",
      sql`${t.fileCount} BETWEEN 0 AND ${sql.raw(String(PROJECT_TREE_FILES_MAX))} AND ${t.bytes} >= 0`,
    ),
  ],
);

/**
 * The whole tree of a commit (CM1: a snapshot, not a delta), one row per file. `blob_ref` is the
 * S3 key (listed in `blob-refs.ts`): `files/<id>` keys of imported files (MG4) or the new
 * content-addressed `teams/<t>/projects/<p>/blobs/<sha256>`, shared between commits. Rows go with
 * their commit; the legal-hold guard refuses that while a hold covers the team.
 */
export const projectTreeEntries = pgTable(
  "project_tree_entries",
  {
    teamId: teamRef(),
    commitId: uuid().notNull(),
    path: text().notNull(),
    sha256: text().notNull(),
    blobRef: text().notNull(),
    sizeBytes: bigint({ mode: "number" }).notNull(),
    mimeType: text().notNull(),
    executable: boolean().notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.commitId, t.path] }),
    foreignKey({
      name: "project_tree_entries_commit_fk",
      columns: [t.teamId, t.commitId],
      foreignColumns: [projectCommits.teamId, projectCommits.id],
    }).onDelete("cascade"),
    // "Does any remaining commit still reference this blob" (pruning, GV3).
    index("project_tree_entries_blob_ref_idx").on(t.teamId, t.blobRef),
    check(
      "project_tree_entries_path",
      sql`char_length(${t.path}) BETWEEN 1 AND 1024 AND ${t.path} !~ '(^/|//|/$|\\\\)' AND ${t.path} !~ '(^|/)\\.\\.?(/|$)'`,
    ),
    check(
      "project_tree_entries_size",
      sql`${t.sizeBytes} BETWEEN 0 AND ${sql.raw(String(PROJECT_FILE_MAX_BYTES))}`,
    ),
    check("project_tree_entries_sha256", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * A member's working copy of a project (CM2): one per (project, member). `base_commit_id` is the
 * commit the working copy started from (null for a project with no commit yet); its key refuses
 * deleting a checkout's base (GV3 pruning never may). Ends with Discard, a commit keeps it and
 * moves the base.
 */
export const projectCheckouts = pgTable(
  "project_checkouts",
  {
    teamId: teamRef(),
    projectId: uuid().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    baseCommitId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.projectId, t.userId] }),
    foreignKey({
      name: "project_checkouts_project_fk",
      columns: [t.teamId, t.projectId],
      foreignColumns: [projects.teamId, projects.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "project_checkouts_base_fk",
      columns: [t.teamId, t.projectId, t.baseCommitId],
      foreignColumns: [projectCommits.teamId, projectCommits.projectId, projectCommits.id],
    }),
    // A member's checkouts (sync pull, mounts) and the base lookup when pruning.
    index("project_checkouts_user_idx").on(t.teamId, t.userId),
    index("project_checkouts_base_idx")
      .on(t.teamId, t.baseCommitId)
      .where(sql`${t.baseCommitId} IS NOT NULL`),
  ],
);
