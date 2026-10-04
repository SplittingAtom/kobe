import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { teamSkillVersions } from "./skills.js";
import { teams } from "./teams.js";

// Scan results and review state of team skill versions (KOBE-80, spec D22). They live beside the
// version rows, not in them: versions are immutable (trigger), review state is not. A version is
// usable only with an `approved` row; a version without a row (older than this table) is not.
// Personal skills (install-wide, run only for their owner) have no team to review them.

export const skillReviewStatus = pgEnum("skill_review_status", ["pending", "approved", "rejected"]);
export type SkillReviewStatus = (typeof skillReviewStatus.enumValues)[number];

/** One finding of `@kobe/skill-scanner`, as stored. */
export interface StoredFinding {
  readonly category: string;
  readonly rule: string;
  readonly file: string;
  readonly line: number;
  readonly excerpt: string;
}

/** Team table: one row per team skill version, created with the version. */
export const teamSkillReviews = pgTable(
  "team_skill_reviews",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    skillId: uuid().notNull(),
    version: integer().notNull(),
    status: skillReviewStatus().notNull().default("pending"),
    /** The scanner reported at least one finding: such a version always needs a review. */
    flagged: boolean().notNull(),
    findings: jsonb().$type<StoredFinding[]>().notNull(),
    scripts: jsonb().$type<string[]>().notNull(),
    skipped: jsonb().$type<string[]>().notNull(),
    scannedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // Users are deactivated, never deleted (NO ACTION).
    reviewedBy: uuid().references(() => users.id),
    reviewedAt: timestamp({ withTimezone: true }),
    reviewNote: text(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.skillId, t.version] }),
    foreignKey({
      name: "team_skill_reviews_version_fk",
      columns: [t.teamId, t.skillId, t.version],
      foreignColumns: [
        teamSkillVersions.teamId,
        teamSkillVersions.skillId,
        teamSkillVersions.version,
      ],
    }).onDelete("cascade"),
    check(
      "team_skill_reviews_decided",
      sql`(${t.status} = 'pending') = (${t.reviewedBy} IS NULL AND ${t.reviewedAt} IS NULL)`,
    ),
    check(
      "team_skill_reviews_json",
      sql`jsonb_typeof(${t.findings}) = 'array' AND jsonb_typeof(${t.scripts}) = 'array' AND jsonb_typeof(${t.skipped}) = 'array'`,
    ),
    check("team_skill_reviews_note", sql`char_length(${t.reviewNote}) <= 2000`),
  ],
);

/** Team table: the team's skill switches (one row per team, created on first change). */
export const teamSkillSettings = pgTable("team_skill_settings", {
  teamId: uuid()
    .primaryKey()
    .references(() => teams.id, { onDelete: "cascade" }),
  /** Members' personal skills are left out of this team's runs (spec D22). */
  personalSkillsDisabled: boolean().notNull().default(false),
  updatedBy: uuid()
    .notNull()
    .references(() => users.id),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
