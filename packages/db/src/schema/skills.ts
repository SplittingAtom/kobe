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
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { teams } from "./teams.js";

// Skill bundles (spec D19/§5.4, KOBE-78). Like agents, the spec's one skills table is split by
// scope because a team table's team_id is NOT NULL (D5):
//   - team skills live in the team table `team_skills` (RLS on team_id);
//   - personal skills (they follow the user into every team, D9) live in install-wide
//     `install_skills`; the server confines them to their owner.
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

export const skillSource = pgEnum("skill_source", ["zip", "skill_md"]);
export type SkillSource = (typeof skillSource.enumValues)[number];

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
  version: integer().notNull(),
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
    "version" | "frontmatter" | "contentHash" | "sizeBytes" | "fileCount" | "uncompressedBytes",
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
  },
  (t): PgTableExtraConfigValue[] => [
    // (team_id, id): other team tables reference a skill with team_id included (KOBE-29 rule).
    primaryKey({ columns: [t.teamId, t.id] }),
    unique("team_skills_slug_unique").on(t.teamId, t.slug),
    ...skillChecks("team_skills", t),
  ],
);

/** Install-wide (†): personal skills, owned by one user and usable in any of their teams (D9). */
export const installSkills = pgTable(
  "install_skills",
  {
    id: uuid().primaryKey().defaultRandom(),
    ownerUserId: uuid()
      .notNull()
      .references(() => users.id),
    ...skillColumns(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique("install_skills_slug_unique").on(t.ownerUserId, t.slug),
    ...skillChecks("install_skills", t),
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
    ...versionChecks("team_skill_versions", t),
  ],
);

/** Install-wide (†): immutable versions of personal skills (app role: SELECT and INSERT only). */
export const installSkillVersions = pgTable(
  "install_skill_versions",
  {
    skillId: uuid().notNull(),
    ...versionColumns(),
  },
  (t): PgTableExtraConfigValue[] => [
    primaryKey({ columns: [t.skillId, t.version] }),
    foreignKey({
      name: "install_skill_versions_skill_fk",
      columns: [t.skillId],
      foreignColumns: [installSkills.id],
    }),
    ...versionChecks("install_skill_versions", t),
  ],
);
