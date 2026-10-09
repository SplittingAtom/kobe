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
import { teams } from "./teams.js";

// Projects (KOBE-160 = 57b of KOBE-57, spec D23; contract: packages/protocol/src/projects.ts).
// Team tables: every key and foreign key includes team_id. File content lives in S3
// (`project_files.blob_ref`, listed in `blob-refs.ts`), never in Postgres.

/** `owner` manages the project and its members; `member` uses it (protocol `projectRoleSchema`). */
export const PROJECT_ROLE_VALUES = ["owner", "member"] as const;
export type ProjectRole = (typeof PROJECT_ROLE_VALUES)[number];

/** `team`: every team member is an implicit member; `selected`: only `project_members` rows. */
export const PROJECT_MEMBERS_MODE_VALUES = ["team", "selected"] as const;
export type ProjectMembersMode = (typeof PROJECT_MEMBERS_MODE_VALUES)[number];

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
    membersMode: text().$type<ProjectMembersMode>().notNull().default("team"),
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
    check("projects_members_mode", sql`${t.membersMode} IN ('team', 'selected')`),
  ],
);

/**
 * Explicit project members. With `members_mode = 'team'` the rows only name owners (everyone
 * else is an implicit member); with `selected` they are the whole membership. "The last owner
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
    role: text().$type<ProjectRole>().notNull().default("member"),
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
    // "Which projects is this user in" (project list for a selected-mode member).
    index("project_members_user_idx").on(t.teamId, t.userId),
    check("project_members_role", sql`${t.role} IN ('owner', 'member')`),
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
