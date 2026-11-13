import { sql, type SQL } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  customType,
  date,
  type ExtraConfigColumn,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  type PgTableExtraConfigValue,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { runs } from "./runs.js";
import { teams } from "./teams.js";

// Semantic memory (v1.3, KOBE-376 = SMA1; spec SM3, SM6, SM10, SM18, SM23, Q11): short typed
// statements beside D24 file memory (the UI's Notes). Split by tenancy, as skills and agents are,
// because a team table's team_id is NOT NULL (D5) and the catalog check forbids mixed tables:
//   - Workspace items (scope user|team; `team` = the Workspace) live in team tables under RLS;
//   - portable items (a person's preferences that follow them into every Workspace) live in
//     site-wide `portable_memory_items`, shaped like `personal_skills`: the server confines rows to
//     their owner;
//   - Site items (and Policy, which exists only there) live in site-wide `site_memory_items`,
//     shaped like `site_settings`: read by every Workspace, written only by the server for Site
//     admins and stewards.
// Every edit appends an immutable numbered version (a trigger refuses UPDATE and direct DELETE);
// `statement_tsv` is generated with the fixed 'english' config (Q11: no search-language setting).
// GIN (tsvector + pg_trgm) only on the site-wide version tables: under FORCE RLS the planner never
// uses a GIN index for `@@`/`%` (not LEAKPROOF; see 0013_thread_search.sql), so the Workspace tables
// get btree indexes and a team-bounded scan (≤ 1,000 items per scope, SM21). No SECURITY DEFINER.

/** Wire scope names (SM6). `team` is the Workspace; `user` = one person in one Workspace. */
export const SEMANTIC_MEMORY_SCOPE_VALUES = ["user", "portable", "team", "site"] as const;
export type SemanticMemoryScope = (typeof SEMANTIC_MEMORY_SCOPE_VALUES)[number];
/** Scopes held in the Workspace (team) tables. */
export const WORKSPACE_MEMORY_SCOPE_VALUES = ["user", "team"] as const;
export type WorkspaceMemoryScope = (typeof WORKSPACE_MEMORY_SCOPE_VALUES)[number];

export const SEMANTIC_MEMORY_KIND_VALUES = [
  "preference",
  "fact",
  "convention",
  "definition",
  "decision",
] as const;
export type SemanticMemoryKind = (typeof SEMANTIC_MEMORY_KIND_VALUES)[number];

export const SEMANTIC_MEMORY_STATUS_VALUES = ["active", "archived", "superseded"] as const;
export type SemanticMemoryStatus = (typeof SEMANTIC_MEMORY_STATUS_VALUES)[number];

/** Who wrote a version: a person, an import, or a person accepting a learning pass's candidate. */
export const SEMANTIC_MEMORY_ACTOR_KIND_VALUES = ["user", "import", "pass"] as const;
/** Site versions also come from an accepted Site proposal (Phase C, KOBE-402), never from a pass. */
export const SITE_MEMORY_ACTOR_KIND_VALUES = ["user", "import", "proposal"] as const;
export type SemanticMemoryActorKind = (typeof SEMANTIC_MEMORY_ACTOR_KIND_VALUES)[number];
export type SiteMemoryActorKind = (typeof SITE_MEMORY_ACTOR_KIND_VALUES)[number];

/** Longest statement (SM3). */
export const SEMANTIC_MEMORY_STATEMENT_MAX = 500;
/** Most tags per item. */
export const SEMANTIC_MEMORY_TAGS_MAX = 5;
/** Longest tag. */
export const SEMANTIC_MEMORY_TAG_MAX = 40;
/** Most thread entries cited by one version. */
export const SEMANTIC_MEMORY_SOURCE_ENTRIES_MAX = 50;
/** Backstop for a version's evidence (quotes and offsets); the server caps it lower. */
export const SEMANTIC_MEMORY_EVIDENCE_MAX_BYTES = 16 * 1024;

const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => "tsvector",
});

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));
const n = (value: number) => sql.raw(String(value));
const ts = () => timestamp({ withTimezone: true });
const teamRef = () =>
  uuid()
    .notNull()
    .references(() => teams.id, { onDelete: "cascade" });

/** Columns every item table shares (kind, status, supersession, pin, tags, version pointer). */
const itemColumns = () => ({
  kind: text().$type<SemanticMemoryKind>().notNull(),
  status: text().$type<SemanticMemoryStatus>().notNull().default("active"),
  /** The item that replaced this one; set exactly when `status = 'superseded'`. */
  supersededBy: uuid(),
  pinned: boolean().notNull().default(false),
  tags: text()
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  /** Newest row of the versions table (a row exists only with its first version). */
  currentVersion: integer().notNull().default(1),
  createdAt: ts().notNull().defaultNow(),
  updatedAt: ts().notNull().defaultNow(),
});

interface ItemCheckColumns {
  kind: AnyPgColumn;
  status: AnyPgColumn;
  supersededBy: AnyPgColumn;
  tags: AnyPgColumn;
  currentVersion: AnyPgColumn;
  id: AnyPgColumn;
}

const itemChecks = (
  prefix: string,
  t: ItemCheckColumns,
  kinds: SQL = list(SEMANTIC_MEMORY_KIND_VALUES),
): PgTableExtraConfigValue[] => [
  check(`${prefix}_kind`, sql`${t.kind} IN (${kinds})`),
  check(`${prefix}_status`, sql`${t.status} IN (${list(SEMANTIC_MEMORY_STATUS_VALUES)})`),
  check(
    `${prefix}_superseded`,
    sql`(${t.status} = 'superseded') = (${t.supersededBy} IS NOT NULL) AND ${t.supersededBy} IS DISTINCT FROM ${t.id}`,
  ),
  // No empty tag; array_position finds a NULL element too.
  check(
    `${prefix}_tags`,
    sql`cardinality(${t.tags}) <= ${n(SEMANTIC_MEMORY_TAGS_MAX)} AND array_position(${t.tags}, NULL) IS NULL AND '' <> ALL(${t.tags}) AND char_length(array_to_string(${t.tags}, '')) <= ${n(SEMANTIC_MEMORY_TAGS_MAX * SEMANTIC_MEMORY_TAG_MAX)}`,
  ),
  check(`${prefix}_version`, sql`${t.currentVersion} >= 1`),
];

/** Columns every version table shares. */
const versionColumns = () => ({
  version: integer().notNull(),
  statement: text().notNull(),
  /** Generated, fixed English stemming (Q11); changing it means recomputing the column. */
  statementTsv: tsvector()
    .notNull()
    .generatedAlwaysAs(sql`to_tsvector('english'::regconfig, statement)`),
  /** The person who saved it (users are deactivated, never deleted). */
  actorUserId: uuid()
    .notNull()
    .references(() => users.id),
  /** Saved over a lint warning (SM18), audited by the server. */
  lintOverride: boolean().notNull().default(false),
  /** Saved despite contradicting Policy (SM23), audited by the server. */
  policyOverride: boolean().notNull().default(false),
  createdAt: ts().notNull().defaultNow(),
});

interface VersionCheckColumns {
  version: AnyPgColumn;
  statement: AnyPgColumn;
}

const versionChecks = (prefix: string, t: VersionCheckColumns): PgTableExtraConfigValue[] => [
  check(`${prefix}_version`, sql`${t.version} >= 1`),
  check(
    `${prefix}_statement`,
    sql`char_length(btrim(${t.statement})) >= 1 AND char_length(${t.statement}) <= ${n(SEMANTIC_MEMORY_STATEMENT_MAX)}`,
  ),
];

/** `pass_id` names the learning pass (KOBE-389) exactly when the version came from one. */
const passCheck = (prefix: string, actorKind: AnyPgColumn, passId: AnyPgColumn) =>
  check(`${prefix}_pass`, sql`(${actorKind} = 'pass') = (${passId} IS NOT NULL)`);

/** Full-text and trigram GIN indexes; only on the site-wide version tables (no RLS). */
const searchIndexes = (
  prefix: string,
  t: { statementTsv: ExtraConfigColumn; statement: ExtraConfigColumn },
) => [
  index(`${prefix}_tsv_idx`).using("gin", t.statementTsv),
  index(`${prefix}_trgm_idx`).using("gin", t.statement.op("gin_trgm_ops")),
];

// ---------------------------------------------------------------------------------------------
// Workspace (team tables: team_id NOT NULL, ENABLE + FORCE RLS, canonical policy)
// ---------------------------------------------------------------------------------------------

/**
 * Team table: one Workspace item. `scope = 'user'`: one person's item in this Workspace
 * (`owner_user_id` set); `scope = 'team'`: shared by the Workspace (`owner_user_id` null; curators
 * edit it). `as_of` dates a fact or decision (shown "as of Oct 2026"). Never auto-evicted.
 */
export const semanticMemoryItems = pgTable(
  "semantic_memory_items",
  {
    teamId: teamRef(),
    id: uuid().notNull().defaultRandom(),
    scope: text().$type<WorkspaceMemoryScope>().notNull(),
    ownerUserId: uuid().references(() => users.id),
    ...itemColumns(),
    asOf: date(),
  },
  (t): PgTableExtraConfigValue[] => [
    primaryKey({ columns: [t.teamId, t.id] }),
    // A replacement lives in the same Workspace; NO ACTION, so a superseding item can't vanish
    // under the one it replaced (deleting both in one statement, e.g. the team cascade, passes).
    foreignKey({
      name: "semantic_memory_items_superseded_by_fk",
      columns: [t.teamId, t.supersededBy],
      foreignColumns: [t.teamId, t.id],
    }),
    check(
      "semantic_memory_items_scope",
      sql`${t.scope} IN (${list(WORKSPACE_MEMORY_SCOPE_VALUES)})`,
    ),
    check(
      "semantic_memory_items_owner",
      sql`(${t.scope} = 'user') = (${t.ownerUserId} IS NOT NULL)`,
    ),
    ...itemChecks("semantic_memory_items", t),
    // The selector's reads (EXPLAIN plans in docs/ledger/KOBE-376.md): shared items by status,
    // and one person's items in this Workspace.
    index("semantic_memory_items_scope_idx").on(t.teamId, t.scope, t.status),
    index("semantic_memory_items_owner_idx")
      .on(t.teamId, t.ownerUserId, t.status)
      .where(sql`${t.scope} = 'user'`),
  ],
);

/**
 * Team table: immutable versions of Workspace items (history and Undo; restore = a new version).
 * Provenance: `source_thread_id` and `source_entry_ids` name the conversation (no key, so a purged
 * thread leaves history alone; the server checks the thread is in this Workspace), `evidence` holds
 * the quotes a learning pass verified, and `pass_id` the pass (no key: passes are purged first).
 */
export const semanticMemoryItemVersions = pgTable(
  "semantic_memory_item_versions",
  {
    teamId: teamRef(),
    itemId: uuid().notNull(),
    ...versionColumns(),
    actorKind: text().$type<SemanticMemoryActorKind>().notNull(),
    passId: uuid(),
    sourceThreadId: uuid(),
    sourceEntryIds: text().array(),
    evidence: jsonb().$type<unknown>(),
  },
  (t): PgTableExtraConfigValue[] => [
    primaryKey({ columns: [t.teamId, t.itemId, t.version] }),
    foreignKey({
      name: "semantic_memory_item_versions_item_fk",
      columns: [t.teamId, t.itemId],
      foreignColumns: [semanticMemoryItems.teamId, semanticMemoryItems.id],
    }).onDelete("cascade"),
    ...versionChecks("semantic_memory_item_versions", t),
    check(
      "semantic_memory_item_versions_actor",
      sql`${t.actorKind} IN (${list(SEMANTIC_MEMORY_ACTOR_KIND_VALUES)})`,
    ),
    passCheck("semantic_memory_item_versions", t.actorKind, t.passId),
    check(
      "semantic_memory_item_versions_sources",
      sql`${t.sourceEntryIds} IS NULL OR (${t.sourceThreadId} IS NOT NULL AND cardinality(${t.sourceEntryIds}) BETWEEN 1 AND ${n(SEMANTIC_MEMORY_SOURCE_ENTRIES_MAX)})`,
    ),
    check(
      "semantic_memory_item_versions_evidence",
      sql`${t.evidence} IS NULL OR (jsonb_typeof(${t.evidence}) IN ('array', 'object') AND octet_length(${t.evidence}::text) <= ${n(SEMANTIC_MEMORY_EVIDENCE_MAX_BYTES)})`,
    ),
  ],
);

/**
 * Team table: which Workspace item versions a run was given (U48, context viewer). Goes with the
 * run (cascade) and with the item (cascade: purging an item removes its run records).
 */
export const runMemoryItems = pgTable(
  "run_memory_items",
  {
    teamId: teamRef(),
    runId: uuid().notNull(),
    itemId: uuid().notNull(),
    version: integer().notNull(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    primaryKey({ columns: [t.teamId, t.runId, t.itemId] }),
    foreignKey({
      name: "run_memory_items_run_fk",
      columns: [t.teamId, t.runId],
      foreignColumns: [runs.teamId, runs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "run_memory_items_version_fk",
      columns: [t.teamId, t.itemId, t.version],
      foreignColumns: [
        semanticMemoryItemVersions.teamId,
        semanticMemoryItemVersions.itemId,
        semanticMemoryItemVersions.version,
      ],
    }).onDelete("cascade"),
    // Which runs used an item (cascade lookups and "used in n runs").
    index("run_memory_items_item_idx").on(t.teamId, t.itemId),
  ],
);

// ---------------------------------------------------------------------------------------------
// Portable (site-wide †, like personal_skills: no team_id; the server confines rows to the owner)
// ---------------------------------------------------------------------------------------------

/**
 * Site-wide (†): a person's portable preferences, shown in every Workspace they belong to. Only
 * `preference` (SM6); facts stay inside their Workspace. No thread links or evidence: those are
 * Workspace content and would cross the wall (they stay on the candidate in its Workspace).
 */
export const portableMemoryItems = pgTable(
  "portable_memory_items",
  {
    id: uuid().primaryKey().defaultRandom(),
    ownerUserId: uuid()
      .notNull()
      .references(() => users.id),
    ...itemColumns(),
  },
  (t): PgTableExtraConfigValue[] => [
    // A replacement belongs to the same person.
    unique("portable_memory_items_id_owner_unique").on(t.id, t.ownerUserId),
    foreignKey({
      name: "portable_memory_items_superseded_by_fk",
      columns: [t.supersededBy, t.ownerUserId],
      foreignColumns: [t.id, t.ownerUserId],
    }),
    ...itemChecks("portable_memory_items", t, list(["preference"])),
    index("portable_memory_items_owner_idx").on(t.ownerUserId, t.status),
  ],
);

/** Site-wide (†): immutable versions of portable items (app role: SELECT and INSERT only). */
export const portableMemoryItemVersions = pgTable(
  "portable_memory_item_versions",
  {
    itemId: uuid().notNull(),
    ...versionColumns(),
    actorKind: text().$type<SemanticMemoryActorKind>().notNull(),
    passId: uuid(),
  },
  (t): PgTableExtraConfigValue[] => [
    primaryKey({ columns: [t.itemId, t.version] }),
    foreignKey({
      name: "portable_memory_item_versions_item_fk",
      columns: [t.itemId],
      foreignColumns: [portableMemoryItems.id],
    }).onDelete("cascade"),
    ...versionChecks("portable_memory_item_versions", t),
    check(
      "portable_memory_item_versions_actor",
      sql`${t.actorKind} IN (${list(SEMANTIC_MEMORY_ACTOR_KIND_VALUES)})`,
    ),
    passCheck("portable_memory_item_versions", t.actorKind, t.passId),
    ...searchIndexes("portable_memory_item_versions", t),
  ],
);

// ---------------------------------------------------------------------------------------------
// Site (site-wide †, like site_settings: read in every Workspace, written by the server only for
// Site admins and stewards; no evidence, rationale or thread links ever reach it)
// ---------------------------------------------------------------------------------------------

/**
 * Site-wide (†): Site knowledge. `policy` marks Policy (SM23: overrides everything, ≤ 25 items and
 * ≤ 2 KiB, enforced by the server); Policy exists only in this table.
 */
export const siteMemoryItems = pgTable(
  "site_memory_items",
  {
    id: uuid().primaryKey().defaultRandom(),
    ...itemColumns(),
    policy: boolean().notNull().default(false),
    asOf: date(),
  },
  (t): PgTableExtraConfigValue[] => [
    foreignKey({
      name: "site_memory_items_superseded_by_fk",
      columns: [t.supersededBy],
      foreignColumns: [t.id],
    }),
    ...itemChecks("site_memory_items", t),
    index("site_memory_items_status_idx").on(t.status, t.policy),
  ],
);

/**
 * Site-wide (†): immutable versions of Site items. `proposal_id` names the accepted Site proposal
 * (Phase C, KOBE-402; no key yet) exactly when `actor_kind = 'proposal'`.
 */
export const siteMemoryItemVersions = pgTable(
  "site_memory_item_versions",
  {
    itemId: uuid().notNull(),
    ...versionColumns(),
    actorKind: text().$type<SiteMemoryActorKind>().notNull(),
    proposalId: uuid(),
  },
  (t): PgTableExtraConfigValue[] => [
    primaryKey({ columns: [t.itemId, t.version] }),
    foreignKey({
      name: "site_memory_item_versions_item_fk",
      columns: [t.itemId],
      foreignColumns: [siteMemoryItems.id],
    }).onDelete("cascade"),
    ...versionChecks("site_memory_item_versions", t),
    check(
      "site_memory_item_versions_actor",
      sql`${t.actorKind} IN (${list(SITE_MEMORY_ACTOR_KIND_VALUES)})`,
    ),
    check(
      "site_memory_item_versions_proposal",
      sql`(${t.actorKind} = 'proposal') = (${t.proposalId} IS NOT NULL)`,
    ),
    ...searchIndexes("site_memory_item_versions", t),
  ],
);
