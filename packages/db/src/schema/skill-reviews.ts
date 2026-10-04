import { sql } from "drizzle-orm";
import {
  boolean,
  index,
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
import { installSkillVersions } from "./skills.js";
import { teams } from "./teams.js";

// Scan results and review state of team skill versions (KOBE-80, spec D22). They live beside the
// version rows, not in them: versions are immutable (trigger), review state is not. A version is
// usable only with an `approved` row. A flagged (or not yet scanned) personal skill version is
// unusable in a team until that team's admin approves it there: its row is keyed by team and
// version and made when a member's run first meets the version. Unflagged personal versions need
// no row (their scan is in `install_skill_scans`).

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

export const skillReviewScope = ["team", "personal"] as const;

/** Install-wide: the scan of a personal skill version, made with the (immutable) version. */
export const installSkillScans = pgTable(
  "install_skill_scans",
  {
    skillId: uuid().notNull(),
    version: integer().notNull(),
    flagged: boolean().notNull(),
    findings: jsonb().$type<StoredFinding[]>().notNull(),
    scripts: jsonb().$type<string[]>().notNull(),
    skipped: jsonb().$type<string[]>().notNull(),
    scannedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.skillId, t.version] }),
    foreignKey({
      name: "install_skill_scans_version_fk",
      columns: [t.skillId, t.version],
      foreignColumns: [installSkillVersions.skillId, installSkillVersions.version],
    }),
  ],
);

/**
 * Team table: one row per team skill version (made with it) or per personal skill version that
 * needs this team's approval. Skill ids are uuids from two tables and never collide.
 */
export const teamSkillReviews = pgTable(
  "team_skill_reviews",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    skillId: uuid().notNull(),
    version: integer().notNull(),
    /** `team`: a team skill version; `personal`: a member's personal version used in this team. */
    scope: text().$type<(typeof skillReviewScope)[number]>().notNull(),
    /** Copied from the immutable version, so the queue needs no join. */
    slug: text().notNull(),
    contentHash: text().notNull(),
    status: skillReviewStatus().notNull().default("pending"),
    /** Existing versions are backfilled unscanned; the queue scans them when first listed. */
    unscanned: boolean().notNull().default(false),
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
    // The review queue: one status, flagged first, oldest scan first.
    index("team_skill_reviews_queue_idx").on(t.teamId, t.status, t.flagged.desc(), t.scannedAt),
    check("team_skill_reviews_scope", sql`${t.scope} IN ('team', 'personal')`),
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
