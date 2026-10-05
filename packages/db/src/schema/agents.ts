import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  foreignKey,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  type PgTableExtraConfigValue,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { teams } from "./teams.js";

// Agent definitions (spec D19, §5.4, §6.3). The spec's one `agents(team_id?, …)` table is split by
// scope, because a team table's team_id is NOT NULL (D5):
//   - team agents live in the team table `team_agents` (RLS on team_id);
//   - personal agents (follow the user install-wide, D6/D9) and gallery agents (install-wide,
//     admin-curated, read-only to teams) live in the install-wide `install_agents`.
// Each row is the agent's editable draft: `frontmatter` (the file's YAML as JSON, validated by
// @kobe/agent-file) and `prompt` (the body). Publish (KOBE-46) copies the draft into an immutable
// numbered version with a frozen tool manifest (`team_agent_versions` / `install_agent_versions`)
// and points `current_version` at it (a foreign key, so it always names an existing version).
// Versions are immutable in the database (a trigger refuses UPDATE and direct DELETE) and threads
// pin them with NO ACTION foreign keys, so a pinned version can never disappear; an agent with
// versions is archived (`archived_at`), never deleted.

/** Which table a thread's pinned agent lives in (`threads.agent_scope`). */
export const agentScope = pgEnum("agent_scope", ["team", "personal", "gallery"]);
export type AgentScope = (typeof agentScope.enumValues)[number];

export const agentStatus = pgEnum("agent_status", ["active", "suspended"]);
export type AgentStatus = (typeof agentStatus.enumValues)[number];

export const installAgentScope = pgEnum("install_agent_scope", ["personal", "gallery"]);
export type InstallAgentScope = (typeof installAgentScope.enumValues)[number];

/** Mirrors `agentSlugSchema` in @kobe/agent-file. */
const SLUG_FORMAT = "^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$";
/** Mirrors AGENT_FILE_LIMITS.promptBytes; the server validates first, this is the backstop. */
const PROMPT_MAX_BYTES = 100 * 1024;
const FRONTMATTER_MAX_BYTES = 32 * 1024;
/** Backstop for a version's frozen tool manifest (the server's is far smaller). */
const MANIFEST_MAX_BYTES = 64 * 1024;

const definitionColumns = () => ({
  slug: text().notNull(),
  status: agentStatus().notNull().default("active"),
  frontmatter: jsonb().$type<Record<string, unknown>>().notNull(),
  prompt: text().notNull().default(""),
  /** Draft revision, +1 on every edit: the ETag for optimistic concurrency (If-Match). */
  revision: integer().notNull().default(1),
  /** Latest published version (KOBE-46); null until the first publish. Versions only grow. */
  currentVersion: integer(),
  /** Set when an agent with versions is retired (KOBE-46): no new threads, no edits. */
  archivedAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  /**
   * Provenance of a fork (KOBE-87): the agent and published version this one was copied from.
   * No foreign key: the source may be a personal agent its owner later deletes. Null otherwise.
   */
  forkedFromAgentId: uuid(),
  forkedFromVersion: integer(),
});

/** Team table: agents published to a team by its Builders and Team admins (D8, D19). */
export const teamAgents = pgTable(
  "team_agents",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    id: uuid().notNull().defaultRandom(),
    // Creator; edits by other builders need team admin. Users are never deleted (NO ACTION).
    ownerUserId: uuid()
      .notNull()
      .references(() => users.id),
    ...definitionColumns(),
  },
  // Annotated: team_agents and team_agent_versions reference each other.
  (t): PgTableExtraConfigValue[] => [
    // (team_id, id): other team tables reference an agent with team_id included (KOBE-29 rule).
    primaryKey({ columns: [t.teamId, t.id] }),
    foreignKey({
      name: "team_agents_current_version_fk",
      columns: [t.teamId, t.id, t.currentVersion],
      foreignColumns: [
        teamAgentVersions.teamId,
        teamAgentVersions.agentId,
        teamAgentVersions.version,
      ],
    }),
    unique("team_agents_slug_unique").on(t.teamId, t.slug),
    check("team_agents_slug_format", sql`${t.slug} ~ ${sql.raw(`'${SLUG_FORMAT}'`)}`),
    check(
      "team_agents_prompt_size",
      sql`octet_length(${t.prompt}) <= ${sql.raw(String(PROMPT_MAX_BYTES))}`,
    ),
    check(
      "team_agents_frontmatter_object",
      sql`jsonb_typeof(${t.frontmatter}) = 'object' AND octet_length(${t.frontmatter}::text) <= ${sql.raw(String(FRONTMATTER_MAX_BYTES))}`,
    ),
    check(
      "team_agents_fork_version",
      sql`${t.forkedFromVersion} IS NULL OR (${t.forkedFromAgentId} IS NOT NULL AND ${t.forkedFromVersion} > 0)`,
    ),
    check("team_agents_revision_positive", sql`${t.revision} > 0`),
    check(
      "team_agents_current_version_positive",
      sql`${t.currentVersion} IS NULL OR ${t.currentVersion} > 0`,
    ),
  ],
);

/**
 * Install-wide (†): personal agents (owned by one user, usable in any of their teams, D9) and
 * gallery agents (no owner; install admins curate, everyone reads, teams fork). No RLS: the
 * server confines personal agents to their owner. No team data and no team foreign keys.
 */
export const installAgents = pgTable(
  "install_agents",
  {
    id: uuid().primaryKey().defaultRandom(),
    scope: installAgentScope().notNull(),
    ownerUserId: uuid().references(() => users.id),
    /**
     * Gallery agents seeded from the repo (KOBE-87): the definition's key and the hash of what was
     * last published from it, so a restart seeds nothing and an upgrade publishes one new version.
     */
    galleryKey: text(),
    galleryHash: text(),
    ...definitionColumns(),
  },
  (t): PgTableExtraConfigValue[] => [
    foreignKey({
      name: "install_agents_current_version_fk",
      columns: [t.id, t.currentVersion],
      foreignColumns: [installAgentVersions.agentId, installAgentVersions.version],
    }),
    uniqueIndex("install_agents_personal_slug_unique")
      .on(t.ownerUserId, t.slug)
      .where(sql`${t.scope} = 'personal'`),
    uniqueIndex("install_agents_gallery_slug_unique")
      .on(t.slug)
      .where(sql`${t.scope} = 'gallery'`),
    uniqueIndex("install_agents_gallery_key_unique")
      .on(t.galleryKey)
      .where(sql`${t.galleryKey} IS NOT NULL`),
    check(
      "install_agents_gallery_key_scope",
      sql`${t.galleryKey} IS NULL OR ${t.scope} = 'gallery'`,
    ),
    check(
      "install_agents_fork_version",
      sql`${t.forkedFromVersion} IS NULL OR (${t.forkedFromAgentId} IS NOT NULL AND ${t.forkedFromVersion} > 0)`,
    ),
    check(
      "install_agents_owner_by_scope",
      sql`(${t.scope} = 'personal') = (${t.ownerUserId} IS NOT NULL)`,
    ),
    check("install_agents_slug_format", sql`${t.slug} ~ ${sql.raw(`'${SLUG_FORMAT}'`)}`),
    check(
      "install_agents_prompt_size",
      sql`octet_length(${t.prompt}) <= ${sql.raw(String(PROMPT_MAX_BYTES))}`,
    ),
    check(
      "install_agents_frontmatter_object",
      sql`jsonb_typeof(${t.frontmatter}) = 'object' AND octet_length(${t.frontmatter}::text) <= ${sql.raw(String(FRONTMATTER_MAX_BYTES))}`,
    ),
    check("install_agents_revision_positive", sql`${t.revision} > 0`),
    check(
      "install_agents_current_version_positive",
      sql`${t.currentVersion} IS NULL OR ${t.currentVersion} > 0`,
    ),
  ],
);

const versionColumns = () => ({
  version: integer().notNull(),
  frontmatter: jsonb().$type<Record<string, unknown>>().notNull(),
  prompt: text().notNull(),
  /**
   * The frozen tool manifest (D19, server `agents/manifest.ts`): the tools this version may ever
   * use, computed at publish time against the install floor (and the team's rules for team
   * agents). A ceiling, never a grant: run-time policy still decides every call.
   */
  toolManifest: jsonb().$type<Record<string, unknown>>().notNull(),
  // Users are deactivated, never deleted (NO ACTION).
  publishedBy: uuid()
    .notNull()
    .references(() => users.id),
  publishedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  /** The draft revision published; null for a rollback (which republishes an older version). */
  draftRevision: integer(),
  /** For a rollback: the version whose content this one republishes. */
  republishedFrom: integer(),
});

const versionChecks = (
  prefix: string,
  t: Record<
    "version" | "prompt" | "frontmatter" | "toolManifest" | "draftRevision" | "republishedFrom",
    AnyPgColumn
  >,
) => [
  check(`${prefix}_version_positive`, sql`${t.version} > 0`),
  check(
    `${prefix}_prompt_size`,
    sql`octet_length(${t.prompt}) <= ${sql.raw(String(PROMPT_MAX_BYTES))}`,
  ),
  check(
    `${prefix}_frontmatter_object`,
    sql`jsonb_typeof(${t.frontmatter}) = 'object' AND octet_length(${t.frontmatter}::text) <= ${sql.raw(String(FRONTMATTER_MAX_BYTES))}`,
  ),
  check(
    `${prefix}_tool_manifest_object`,
    sql`jsonb_typeof(${t.toolManifest}) = 'object' AND octet_length(${t.toolManifest}::text) <= ${sql.raw(String(MANIFEST_MAX_BYTES))}`,
  ),
  // A version comes from the draft or republishes an earlier version (rollback), never both.
  check(
    `${prefix}_origin`,
    sql`(${t.draftRevision} IS NULL) <> (${t.republishedFrom} IS NULL) AND (${t.draftRevision} IS NULL OR ${t.draftRevision} > 0) AND (${t.republishedFrom} IS NULL OR (${t.republishedFrom} > 0 AND ${t.republishedFrom} < ${t.version}))`,
  ),
];

/**
 * Team table: published versions of team agents (D19). Immutable (trigger); deleted only by the
 * team's cascade. Pinned by threads `(team_id, team_agent_id, agent_version)`.
 */
export const teamAgentVersions = pgTable(
  "team_agent_versions",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    agentId: uuid().notNull(),
    ...versionColumns(),
  },
  (t): PgTableExtraConfigValue[] => [
    primaryKey({ columns: [t.teamId, t.agentId, t.version] }),
    // NO ACTION: an agent with versions can't be deleted (it is archived instead).
    foreignKey({
      name: "team_agent_versions_agent_fk",
      columns: [t.teamId, t.agentId],
      foreignColumns: [teamAgents.teamId, teamAgents.id],
    }),
    ...versionChecks("team_agent_versions", t),
  ],
);

/**
 * Install-wide (†): published versions of personal and gallery agents. The app role may only
 * SELECT and INSERT (tenancy grants); a trigger refuses changes from anyone else too. The server
 * confines personal versions to their agent's owner, as for `install_agents`.
 */
export const installAgentVersions = pgTable(
  "install_agent_versions",
  {
    agentId: uuid().notNull(),
    ...versionColumns(),
    // Null for gallery versions the server published from the repo's definitions (KOBE-87).
    publishedBy: uuid().references(() => users.id),
  },
  (t): PgTableExtraConfigValue[] => [
    primaryKey({ columns: [t.agentId, t.version] }),
    foreignKey({
      name: "install_agent_versions_agent_fk",
      columns: [t.agentId],
      foreignColumns: [installAgents.id],
    }),
    ...versionChecks("install_agent_versions", t),
  ],
);
