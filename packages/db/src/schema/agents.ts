import { sql } from "drizzle-orm";
import {
  check,
  integer,
  jsonb,
  pgEnum,
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

// Agent definitions (spec D19, §5.4, §6.3). The spec's one `agents(team_id?, …)` table is split by
// scope, because a team table's team_id is NOT NULL (D5):
//   - team agents live in the team table `team_agents` (RLS on team_id);
//   - personal agents (follow the user install-wide, D6/D9) and gallery agents (install-wide,
//     admin-curated, read-only to teams) live in the install-wide `install_agents`.
// Each row is the agent's editable draft: `frontmatter` (the file's YAML as JSON, validated by
// @kobe/agent-file) and `prompt` (the body). Publishing immutable numbered versions with a frozen
// tool manifest, and pointing `current_version` at one, is KOBE-46.

export const agentStatus = pgEnum("agent_status", ["active", "suspended"]);
export type AgentStatus = (typeof agentStatus.enumValues)[number];

export const installAgentScope = pgEnum("install_agent_scope", ["personal", "gallery"]);
export type InstallAgentScope = (typeof installAgentScope.enumValues)[number];

/** Mirrors `agentSlugSchema` in @kobe/agent-file. */
const SLUG_FORMAT = "^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$";
/** Mirrors AGENT_FILE_LIMITS.promptBytes; the server validates first, this is the backstop. */
const PROMPT_MAX_BYTES = 100 * 1024;
const FRONTMATTER_MAX_BYTES = 32 * 1024;

const definitionColumns = () => ({
  slug: text().notNull(),
  status: agentStatus().notNull().default("active"),
  frontmatter: jsonb().$type<Record<string, unknown>>().notNull(),
  prompt: text().notNull().default(""),
  /** Draft revision, +1 on every edit: the ETag for optimistic concurrency (If-Match). */
  revision: integer().notNull().default(1),
  /** Latest published version (KOBE-46); null until the first publish. */
  currentVersion: integer(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
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
  (t) => [
    // (team_id, id): other team tables reference an agent with team_id included (KOBE-29 rule).
    primaryKey({ columns: [t.teamId, t.id] }),
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
    ...definitionColumns(),
  },
  (t) => [
    uniqueIndex("install_agents_personal_slug_unique")
      .on(t.ownerUserId, t.slug)
      .where(sql`${t.scope} = 'personal'`),
    uniqueIndex("install_agents_gallery_slug_unique")
      .on(t.slug)
      .where(sql`${t.scope} = 'gallery'`),
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
