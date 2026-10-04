import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  type PgTableExtraConfigValue,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { agentScope, installAgentVersions, teamAgentVersions } from "./agents.js";
import { MODEL_ALIAS_PATTERN } from "./models.js";
import { users } from "./auth.js";
import { teams } from "./teams.js";

// Conversations (spec D15, §5.4). Team tables: every key and foreign key includes team_id, so
// foreign-key checks and cascades (which bypass RLS) can never reach another team's rows. Other
// areas reference a thread as (team_id, thread_id) → threads (team_id, id) for the same reason.

export const threadStatus = pgEnum("thread_status", ["idle", "running", "interrupted"]);
export type ThreadStatus = (typeof threadStatus.enumValues)[number];

const teamRef = () =>
  uuid()
    .notNull()
    .references(() => teams.id, { onDelete: "cascade" });

/**
 * A conversation. `leaf_entry_id` marks the active branch of the entry tree. `agent_scope`/
 * `agent_id`/`agent_version` pin the published agent version the thread started on (D19, KOBE-46).
 * Agents live in two tables (team_agents, install_agents), so the pin's foreign keys go through
 * two generated columns: `team_agent_id` (set for team agents) → team_agent_versions and
 * `install_agent_id` (personal and gallery agents) → install_agent_versions; MATCH SIMPLE skips
 * the null one. Both are NO ACTION, so a pinned version can never be deleted. Null agent = the
 * install default agent. `project_id`'s foreign key arrives with projects (KOBE-57).
 *
 * `tsv` (§5.4; the title, weight A) is a stored generated column added in SQL by migration
 * `*_thread_search.sql`, like `thread_entries.tsv`; neither is declared here (the entry column depends
 * on a SQL function) and the app never writes or selects them. Search: `searchThreads`.
 * **Never run `drizzle-kit push`** against a Kobe database: it diffs the live schema against these
 * declarations and would drop both `tsv` columns (and anything else SQL-only). Migrations only.
 */
export const threads = pgTable(
  "threads",
  {
    teamId: teamRef(),
    id: uuid().notNull().defaultRandom(),
    // Users are deactivated, never deleted; NO ACTION keeps a stray delete from erasing history.
    ownerUserId: uuid()
      .notNull()
      .references(() => users.id),
    projectId: uuid(),
    agentScope: agentScope(),
    agentId: uuid(),
    agentVersion: integer(),
    /** Generated: `agent_id` when the pinned agent is a team agent (foreign key target). */
    teamAgentId: uuid().generatedAlwaysAs(sql`CASE WHEN agent_scope = 'team' THEN agent_id END`),
    /** Generated: `agent_id` when the pinned agent is personal or gallery (foreign key target). */
    installAgentId: uuid().generatedAlwaysAs(
      sql`CASE WHEN agent_scope IN ('personal', 'gallery') THEN agent_id END`,
    ),
    title: text(),
    leafEntryId: text(),
    status: threadStatus().notNull().default("idle"),
    sharedToProject: boolean().notNull().default(false),
    deletedAt: timestamp({ withTimezone: true }),
    lastActivityAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Last allocated `thread_entries.seq`. Only the seq trigger may change it (by exactly 1). */
    lastEntrySeq: integer().notNull().default(0),
    /**
     * Set when the user stopped the active run while messages were queued (KOBE-26): the queue
     * waits until the user resumes it or sends a new message. Null = the queue moves.
     */
    queuePausedAt: timestamp({ withTimezone: true }),
    /**
     * The model the owner chose for this thread (KOBE-44, D30): a catalog alias, passed as the
     * run's requested alias. Null = the team's default. No foreign key on purpose: an alias the
     * team disables or the install removes stays chosen, and the run fails
     * `agent_model_not_enabled` instead of silently switching models.
     */
    modelAlias: text(),
  },
  // Annotated: threads and thread_entries reference each other (leaf and thread foreign keys).
  (t): PgTableExtraConfigValue[] => [
    primaryKey({ columns: [t.teamId, t.id] }),
    foreignKey({
      name: "threads_leaf_entry_fk",
      columns: [t.teamId, t.id, t.leafEntryId],
      foreignColumns: [threadEntries.teamId, threadEntries.threadId, threadEntries.entryId],
    }),
    // Thread list (D9, §6.1): the owner's live threads by recent activity; id is the keyset tiebreak.
    index("threads_owner_activity_idx")
      .on(t.teamId, t.ownerUserId, t.lastActivityAt.desc(), t.id.desc())
      .where(sql`${t.deletedAt} IS NULL`),
    index("threads_project_activity_idx")
      .on(t.teamId, t.projectId, t.lastActivityAt.desc(), t.id.desc())
      .where(sql`${t.projectId} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    // Trash and the 30-day hard purge (D18).
    index("threads_deleted_idx")
      .on(t.teamId, t.deletedAt)
      .where(sql`${t.deletedAt} IS NOT NULL`),
    // The pinned version (D19). NO ACTION: versions are never deleted while a thread pins them.
    foreignKey({
      name: "threads_team_agent_version_fk",
      columns: [t.teamId, t.teamAgentId, t.agentVersion],
      foreignColumns: [
        teamAgentVersions.teamId,
        teamAgentVersions.agentId,
        teamAgentVersions.version,
      ],
    }),
    foreignKey({
      name: "threads_install_agent_version_fk",
      columns: [t.installAgentId, t.agentVersion],
      foreignColumns: [installAgentVersions.agentId, installAgentVersions.version],
    }),
    // Usage per version (inventory, KOBE-48) and the foreign keys' checks on a team's cascade.
    index("threads_team_agent_idx")
      .on(t.teamId, t.teamAgentId, t.agentVersion)
      .where(sql`${t.teamAgentId} IS NOT NULL`),
    index("threads_install_agent_idx")
      .on(t.teamId, t.installAgentId, t.agentVersion)
      .where(sql`${t.installAgentId} IS NOT NULL`),
    check(
      "threads_agent_pin",
      sql`(${t.agentId} IS NULL) = (${t.agentVersion} IS NULL) AND (${t.agentId} IS NULL) = (${t.agentScope} IS NULL) AND (${t.agentVersion} IS NULL OR ${t.agentVersion} > 0)`,
    ),
    check("threads_last_entry_seq", sql`${t.lastEntrySeq} >= 0`),
    check(
      "threads_model_alias",
      sql`${t.modelAlias} IS NULL OR ${t.modelAlias} ~ ${sql.raw(`'${MODEL_ALIAS_PATTERN}'`)}`,
    ),
  ],
);

/**
 * Pi session format v3 entries, mirrored one-to-one (D15): `entry_id`/`parent_id` are Pi's ids,
 * `type` is Pi's entry type (message, compaction, context_edit, branch_summary, …; text, so a Pi
 * 1.0.x patch adding a type needs no migration). `seq` is the per-thread append order (for
 * rebuilding the JSONL); a trigger assigns it, like `run_events.seq`. Payloads over 64 KB go to S3
 * via `blob_ref`. `tsv` (search text of user/assistant messages, SQL-only) is generated from
 * `type` + `payload`, so writers must store the Pi entry shape (`payload.message.content`).
 */
export const threadEntries = pgTable(
  "thread_entries",
  {
    teamId: teamRef(),
    threadId: uuid().notNull(),
    entryId: text().notNull(),
    parentId: text(),
    seq: integer().notNull().default(0),
    type: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    blobRef: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    primaryKey({ columns: [t.teamId, t.threadId, t.entryId] }),
    foreignKey({
      name: "thread_entries_thread_fk",
      columns: [t.teamId, t.threadId],
      foreignColumns: [threads.teamId, threads.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "thread_entries_parent_fk",
      columns: [t.teamId, t.threadId, t.parentId],
      foreignColumns: [t.teamId, t.threadId, t.entryId],
    }),
    unique("thread_entries_seq_unique").on(t.teamId, t.threadId, t.seq),
    // Children of an entry (branch navigation) and the parent foreign key's delete checks.
    index("thread_entries_parent_idx").on(t.teamId, t.threadId, t.parentId),
    // KOBE-18 adds two SQL-only indexes (migration *_retention_rls.sql, IF NOT EXISTS so operators
    // can build them CONCURRENTLY first): thread_entries_blob_ref_idx and threads_retention_idx.
    check("thread_entries_seq_positive", sql`${t.seq} > 0`),
    check("thread_entries_entry_id_length", sql`char_length(${t.entryId}) BETWEEN 1 AND 128`),
    check("thread_entries_type_nonempty", sql`${t.type} <> ''`),
  ],
);
