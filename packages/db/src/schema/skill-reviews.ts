import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  check,
  foreignKey,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { personalSkillVersions } from "./skills.js";
import { teams } from "./teams.js";

// Scan results and review state of team skill versions (KOBE-80, spec D22). They live beside the
// version rows, not in them: versions are immutable (trigger), review state is not. A version is
// usable only with an `approved` row. A flagged (or not yet scanned) personal skill version is
// unusable in a team until that team's admin approves it there: its row is keyed by team and
// version and made when a member's run first meets the version. Unflagged personal versions need
// no row (their scan is in `personal_skill_scans`).

export const skillReviewStatus = pgEnum("skill_review_status", ["pending", "approved", "rejected"]);
export type SkillReviewStatus = (typeof skillReviewStatus.enumValues)[number];

/** One finding of `@kobe/skill-scanner`, as stored. */
export interface StoredFinding {
  readonly category: string;
  readonly rule: string;
  readonly file: string;
  readonly line: number;
  readonly excerpt: string;
  /** `caution` or `block` (KOBE-312); absent on findings stored before, which count as Caution. */
  readonly severity?: string;
}

export const skillReviewScope = ["team", "personal"] as const;

/** Site-wide: the scan of a personal skill version, made with the (immutable) version. */
export const personalSkillScans = pgTable(
  "personal_skill_scans",
  {
    skillId: uuid().notNull(),
    version: integer().notNull(),
    flagged: boolean().notNull(),
    findings: jsonb().$type<StoredFinding[]>().notNull(),
    scripts: jsonb().$type<string[]>().notNull(),
    skipped: jsonb().$type<string[]>().notNull(),
    scannedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /**
     * The scanner rule set's ordinal (`RULE_SET`, KOBE-313); null: before KOBE-313. A scan under
     * an older rule set is rescanned; rescans only move it forward.
     */
    ruleSet: integer(),
    /**
     * A rescan turned this unreviewed (Pass) version Block (KOBE-313, SK32): it now needs each
     * team's approval, and runs omit it as `suspended` until then.
     */
    suspendedAt: timestamp({ withTimezone: true }),
    /** The suspension's emails went out (the outbox: null while `suspended_at` is set = to send). */
    suspensionNotifiedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.skillId, t.version] }),
    index("personal_skill_scans_rule_set_idx").on(t.ruleSet),
    foreignKey({
      name: "personal_skill_scans_version_fk",
      columns: [t.skillId, t.version],
      foreignColumns: [personalSkillVersions.skillId, personalSkillVersions.version],
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
    /**
     * The scanner rule set's ordinal (`RULE_SET`, KOBE-313); null: before KOBE-313. A scan under
     * an older rule set is rescanned; rescans only move it forward.
     */
    ruleSet: integer(),
    /**
     * A rescan turned this approved version Block (KOBE-313, SK32): it went back to `pending` and
     * runs omit the skill as `suspended` until it is decided again (the decision clears this).
     */
    suspendedAt: timestamp({ withTimezone: true }),
    /** The suspension's emails went out (the outbox: null while `suspended_at` is set = to send). */
    suspensionNotifiedAt: timestamp({ withTimezone: true }),
    // Users are deactivated, never deleted (NO ACTION).
    reviewedBy: uuid().references(() => users.id),
    reviewedAt: timestamp({ withTimezone: true }),
    reviewNote: text(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.skillId, t.version] }),
    // The review queue: one status, flagged first, oldest scan first.
    index("team_skill_reviews_queue_idx").on(t.teamId, t.status, t.flagged.desc(), t.scannedAt),
    // Rescans (KOBE-313): rows under an older rule set, per team.
    index("team_skill_reviews_rule_set_idx").on(t.teamId, t.ruleSet),
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
export const teamSkillSettings = pgTable(
  "team_skill_settings",
  {
    teamId: uuid()
      .primaryKey()
      .references(() => teams.id, { onDelete: "cascade" }),
    /** Members' personal skills are left out of this team's runs (spec D22). */
    personalSkillsDisabled: boolean().notNull().default(false),
    /** "Members may add catalog skills for themselves" (SK25, default on): member adds load. */
    membersMayAddCatalog: boolean().notNull().default(true),
    /** "Builders may install catalog skills" (SK25, default on): Builders manage installs too. */
    buildersMayInstallCatalog: boolean().notNull().default(true),
    /** "Builders may promote without confirmation" (SK19, KOBE-333, default off). */
    buildersMayPromote: boolean().notNull().default(false),
    /**
     * The team's eval judge (KOBE-326, SK17): one of its enabled models, used when the Site's
     * `judge_alias` is not enabled in the team; null (or a model disabled since): the team default.
     * Checked against the team's models when set and again whenever it is used.
     */
    evalJudgeAlias: text(),
    /**
     * The optional monthly team eval cap (KOBE-327, SK18; protocol `teamEvalCapSchema`): dollars
     * or tokens, at most one; none by default. Counted from `model_spend_daily.eval_*` and
     * enforced in `kobe_reserve_budget` (an `eval` line on every eval and eval judge call).
     */
    evalCapUsd: numeric({ precision: 14, scale: 2, mode: "number" }),
    evalCapTokens: bigint({ mode: "number" }),
    updatedBy: uuid()
      .notNull()
      .references(() => users.id),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "team_skill_settings_eval_judge_alias",
      sql`${t.evalJudgeAlias} IS NULL OR char_length(${t.evalJudgeAlias}) BETWEEN 1 AND 64`,
    ),
    check(
      "team_skill_settings_eval_cap",
      sql`(${t.evalCapUsd} IS NULL OR ${t.evalCapTokens} IS NULL)
        AND (${t.evalCapUsd} IS NULL OR (${t.evalCapUsd} > 0 AND ${t.evalCapUsd} <= 1000000))
        AND (${t.evalCapTokens} IS NULL OR ${t.evalCapTokens} BETWEEN 1 AND 1000000000000)`,
    ),
  ],
);
