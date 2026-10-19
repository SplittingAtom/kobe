import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
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
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { teams } from "./teams.js";

// Skill bundles (spec D19/§5.4, KOBE-78). Like agents, the spec's one skills table is split by
// scope because a team table's team_id is NOT NULL (D5):
//   - team skills live in the team table `team_skills` (RLS on team_id);
//   - personal skills (they follow the user into every team, D9) live in site-wide
//     `personal_skills`; the server confines them to their owner.
// Each upload creates an immutable numbered version (`*_skill_versions`): the bundle is a zip in
// object storage (`storage_key`) with its SHA-256 (`content_hash`, what the blocklist and
// materialization use). A trigger refuses UPDATE and direct DELETE of versions. Scan results and
// review status (KOBE-79/80) are not here yet: they are mutable and get their own tables.

/** Mirrors `SKILL_NAME` in the server's skills/bundle.ts: the skill's slug is its frontmatter name. */
const NAME_FORMAT = "^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$";
const DESCRIPTION_MAX = 1024;
const FRONTMATTER_MAX_BYTES = 32 * 1024;
/** Backstop for bundle sizes; the server enforces its (lower, configurable) caps first. */
const BUNDLE_MAX_BYTES = 64 * 1024 * 1024;
/** Mirrors `CHANGELOG_MAX` in the server's skills/semver.ts. */
const CHANGELOG_MAX = 1024;

export const skillSource = pgEnum("skill_source", ["zip", "skill_md"]);
export type SkillSource = (typeof skillSource.enumValues)[number];

/**
 * How a team's members get a team skill (SK14/SK27, KOBE-308): `available` (members opt in),
 * `default_on` (on unless a member turns it off), `required` (always loaded) or `hidden` (only
 * for agents that name it). Team installs of catalog skills use the same modes.
 */
export const skillAccess = pgEnum("skill_access", [
  "available",
  "default_on",
  "required",
  "hidden",
]);
export type SkillAccess = (typeof skillAccess.enumValues)[number];

const skillColumns = () => ({
  /** The SKILL.md frontmatter `name` of the latest upload; unique per team or owner. */
  slug: text().notNull(),
  description: text().notNull(),
  /** Latest uploaded version (0 never occurs: a skill row exists only with its first version). */
  latestVersion: integer().notNull().default(1),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

const versionColumns = () => ({
  /** The version's sequence number: 1, 2, 3, ... per skill (`seq` repeats it). */
  version: integer().notNull(),
  // KOBE-308 (SK14). Nullable here only so the columns could be added to existing rows: the
  // custom migration 0130_skill_semver_backfill backfills them (n -> "0.n.0", seq n) and then
  // requires `semver` and `seq` with SQL-only checks (`*_semver_format`, `*_seq_matches`).
  /** MAJOR.MINOR.PATCH, strictly increasing with `seq`; versions uploaded before read `0.<n>.0`. */
  semver: text(),
  /** Ordering key: equals `version` for local skills; catalog versions have their own. */
  seq: integer(),
  /** The author's changelog line (null for versions uploaded before KOBE-308). */
  changelog: text(),
  /** SHA-256 of the whole package (KOBE-309); null until package builds record it. */
  packageHash: text(),
  /**
   * The package zip (KOBE-310) when it differs from the runtime zip in `storage_key` (the version
   * has `evals/` or `kobe.skill.yaml`); null when the two are the same bytes, and for versions
   * stored before KOBE-310 (their `storage_key` zip is the whole upload).
   */
  packageStorageKey: text(),
  /**
   * Saved from a Workbench draft that started from a conversation, directly or through a fork of
   * such a version (KOBE-333 review C4-M3): SK19 shows it before anything leaves the team. Set at
   * insert (versions are immutable); false for uploads.
   */
  fromConversation: boolean().notNull().default(false),
  /** SKILL.md frontmatter as uploaded (name, description and any other keys). */
  frontmatter: jsonb().$type<Record<string, unknown>>().notNull(),
  source: skillSource().notNull(),
  /** Lowercase hex SHA-256 of the stored zip bytes. */
  contentHash: text().notNull(),
  storageKey: text().notNull(),
  sizeBytes: integer().notNull(),
  fileCount: integer().notNull(),
  uncompressedBytes: integer().notNull(),
  // Users are deactivated, never deleted (NO ACTION).
  uploadedBy: uuid()
    .notNull()
    .references(() => users.id),
  uploadedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

const skillChecks = (
  prefix: string,
  t: Record<"slug" | "description" | "latestVersion", AnyPgColumn>,
) => [
  check(`${prefix}_slug_format`, sql`${t.slug} ~ ${sql.raw(`'${NAME_FORMAT}'`)}`),
  check(
    `${prefix}_description_size`,
    sql`char_length(${t.description}) BETWEEN 1 AND ${sql.raw(String(DESCRIPTION_MAX))}`,
  ),
  check(`${prefix}_latest_version_positive`, sql`${t.latestVersion} > 0`),
];

const versionChecks = (
  prefix: string,
  t: Record<
    | "version"
    | "frontmatter"
    | "contentHash"
    | "packageHash"
    | "packageStorageKey"
    | "changelog"
    | "sizeBytes"
    | "fileCount"
    | "uncompressedBytes",
    AnyPgColumn
  >,
) => [
  check(`${prefix}_version_positive`, sql`${t.version} > 0`),
  check(
    `${prefix}_frontmatter_object`,
    sql`jsonb_typeof(${t.frontmatter}) = 'object' AND octet_length(${t.frontmatter}::text) <= ${sql.raw(String(FRONTMATTER_MAX_BYTES))}`,
  ),
  check(`${prefix}_content_hash_format`, sql`${t.contentHash} ~ '^[0-9a-f]{64}$'`),
  check(
    `${prefix}_package_hash_format`,
    sql`${t.packageHash} IS NULL OR ${t.packageHash} ~ '^[0-9a-f]{64}$'`,
  ),
  check(
    `${prefix}_package_storage`,
    sql`${t.packageStorageKey} IS NULL OR ${t.packageHash} IS NOT NULL`,
  ),
  check(
    `${prefix}_changelog_size`,
    sql`${t.changelog} IS NULL OR char_length(${t.changelog}) BETWEEN 1 AND ${sql.raw(String(CHANGELOG_MAX))}`,
  ),
  check(
    `${prefix}_sizes`,
    sql`${t.sizeBytes} > 0 AND ${t.sizeBytes} <= ${sql.raw(String(BUNDLE_MAX_BYTES))} AND ${t.fileCount} > 0 AND ${t.uncompressedBytes} >= 0`,
  ),
];

/** Team table: skills published to a team by its Builders and Team admins (D8). */
export const teamSkills = pgTable(
  "team_skills",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    id: uuid().notNull().defaultRandom(),
    ownerUserId: uuid()
      .notNull()
      .references(() => users.id),
    ...skillColumns(),
    /**
     * "Offer to all agents" (KOBE-297): the resolver adds the newest approved version to every
     * non-exclusive agent's runs in this team (blocklist respected, deduplicated with named and
     * personal skills). Changed by team admins only.
     */
    offerToAll: boolean().notNull().default(false),
    /**
     * Access mode (KOBE-308, SK27). Backfilled from `offer_to_all` (true -> `default_on`); the
     * server keeps the two in step until the resolver reads `access`.
     */
    access: skillAccess().notNull().default("available"),
    /** Archived (SK33): hidden from new use; versions stay resolvable for frozen agents. */
    archivedAt: timestamp({ withTimezone: true }),
  },
  (t): PgTableExtraConfigValue[] => [
    // (team_id, id): other team tables reference a skill with team_id included (KOBE-29 rule).
    primaryKey({ columns: [t.teamId, t.id] }),
    unique("team_skills_slug_unique").on(t.teamId, t.slug),
    ...skillChecks("team_skills", t),
  ],
);

/** Site-wide (†): personal skills, owned by one user and usable in any of their teams (D9). */
export const personalSkills = pgTable(
  "personal_skills",
  {
    id: uuid().primaryKey().defaultRandom(),
    ownerUserId: uuid()
      .notNull()
      .references(() => users.id),
    ...skillColumns(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique("personal_skills_slug_unique").on(t.ownerUserId, t.slug),
    // The target of a member's per-team toggle (KOBE-316): the skill is that member's own.
    unique("personal_skills_id_owner_unique").on(t.id, t.ownerUserId),
    ...skillChecks("personal_skills", t),
  ],
);

/** Team table: immutable uploaded versions of team skills; deleted only by the team's cascade. */
export const teamSkillVersions = pgTable(
  "team_skill_versions",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    skillId: uuid().notNull(),
    ...versionColumns(),
  },
  (t): PgTableExtraConfigValue[] => [
    primaryKey({ columns: [t.teamId, t.skillId, t.version] }),
    // NO ACTION: a skill with versions can't be deleted (a later ticket adds archiving).
    foreignKey({
      name: "team_skill_versions_skill_fk",
      columns: [t.teamId, t.skillId],
      foreignColumns: [teamSkills.teamId, teamSkills.id],
    }),
    unique("team_skill_versions_semver_unique").on(t.teamId, t.skillId, t.semver),
    ...versionChecks("team_skill_versions", t),
  ],
);

/** Site-wide (†): immutable versions of personal skills (app role: SELECT and INSERT only). */
export const personalSkillVersions = pgTable(
  "personal_skill_versions",
  {
    skillId: uuid().notNull(),
    ...versionColumns(),
  },
  (t): PgTableExtraConfigValue[] => [
    primaryKey({ columns: [t.skillId, t.version] }),
    foreignKey({
      name: "personal_skill_versions_skill_fk",
      columns: [t.skillId],
      foreignColumns: [personalSkills.id],
    }),
    unique("personal_skill_versions_semver_unique").on(t.skillId, t.semver),
    ...versionChecks("personal_skill_versions", t),
  ],
);
