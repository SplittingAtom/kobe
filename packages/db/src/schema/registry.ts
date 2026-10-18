import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { SKILL_HASH_SQL } from "./skill-blocklist.js";
import { teams } from "./teams.js";

// The Site Skills Registry and Catalog (KOBE-311, spec SK5–SK8, SK21–SK24, SK29, SK31). All
// site-wide (†): a catalog skill belongs to the Site, not to a team. The closed sets mirror
// `@kobe/protocol` skill-catalog.ts (a server test keeps them equal). Records only; the bytes of a
// version live in the object store under its runtime and package hashes (KOBE-310).

/** Mirrors `SKILL_NAME_PATTERN` (@kobe/protocol): catalog names share the flat skill namespace. */
const NAME_FORMAT = "^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$";
const SEMVER_FORMAT = "^(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})$";
/** Mirrors `REGISTRY_TAG_PATTERN`. */
const TAG_FORMAT = "^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$";
const SUMMARY_MAX = 280;
/** The code-defined system tags (SK5); mirrors `SYSTEM_TAGS` (@kobe/protocol, a test ties them). */
export const SYSTEM_TAG_NAMES = ["default"] as const;
const NOTE_MAX = 4000;

export const registryPublisher = pgEnum("registry_publisher", ["kobe", "maintainer"]);
export const registrySkillStatus = pgEnum("registry_skill_status", [
  "active",
  "deprecated",
  "unmaintained",
  "archived",
]);
export const registryVersionState = pgEnum("registry_version_state", [
  "submitted",
  "in_review",
  "changes_requested",
  "approved",
  "rejected",
  "deprecated",
  "withdrawn",
  "revoked",
]);
export const scanVerdict = pgEnum("scan_verdict", ["pass", "caution", "block"]);
export const registryReviewAction = pgEnum("registry_review_action", [
  "submitted",
  "claimed",
  "unclaimed",
  "commented",
  "approved",
  "changes_requested",
  "rejected",
  "rejected_and_blocked",
  "evals_rerun",
  "deprecated",
  "withdrawn",
  "revoked",
  "unrevoked",
]);
export const registryTagKind = pgEnum("registry_tag_kind", ["system", "topic"]);
export const registryTagStatus = pgEnum("registry_tag_status", ["active", "retired"]);

const ts = () => timestamp({ withTimezone: true });
const jsonObject = (column: unknown) => sql`jsonb_typeof(${column}) = 'object'`;

/** Site-wide (†): a catalog skill; one flat namespace, never deleted (archived instead). */
export const registrySkills = pgTable(
  "registry_skills",
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    publisher: registryPublisher().notNull().default("maintainer"),
    summary: text().notNull(),
    status: registrySkillStatus().notNull().default("active"),
    /** A deprecated skill may name its replacement (SK31). */
    replacementId: uuid(),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts().notNull().defaultNow(),
  },
  (t) => [
    unique("registry_skills_name_unique").on(t.name),
    foreignKey({
      name: "registry_skills_replacement_fk",
      columns: [t.replacementId],
      foreignColumns: [t.id],
    }),
    check("registry_skills_name_format", sql`${t.name} ~ ${sql.raw(`'${NAME_FORMAT}'`)}`),
    check(
      "registry_skills_summary_size",
      sql`char_length(${t.summary}) BETWEEN 1 AND ${sql.raw(String(SUMMARY_MAX))}`,
    ),
    check("registry_skills_replacement_not_self", sql`${t.replacementId} <> ${t.id}`),
  ],
);

/** Site-wide (†): who maintains a catalog skill (SK24); only maintainers submit new versions. */
export const registryMaintainers = pgTable(
  "registry_maintainers",
  {
    skillId: uuid()
      .notNull()
      .references(() => registrySkills.id),
    // Users are deactivated, never deleted (NO ACTION); the last one leaving marks Unmaintained.
    userId: uuid()
      .notNull()
      .references(() => users.id),
    addedBy: uuid().references(() => users.id),
    addedAt: ts().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.skillId, t.userId] }),
    index("registry_maintainers_user_idx").on(t.userId),
  ],
);

/**
 * Site-wide (†): one submitted version of a catalog skill, from submission to retirement (SK23,
 * SK31). `semver` keeps the local number at promotion; `seq` orders versions; the hashes name the
 * stored bytes. `source` (team, skill, version), `manifest`, `provenance`, `scan`, the scorecards
 * and `mirror` are JSON documents whose shapes the protocol owns.
 *
 * Its identity is immutable once written (trigger `registry_versions_immutable`, migration 0133):
 * only the review state, claim, review, scorecards and mirror change; a new package is a new
 * version that a human reviews. Nobody reviews their own submission, except that a single-admin
 * Site may self-approve, flagged `self_approved` (SK22, as break-glass D10): the guard trigger
 * `registry_versions_review_guard` (0133) decides the flag, and `registry_versions_review` keeps it
 * consistent. The review (reviewer, approval time, flag) is frozen once approved.
 * Team-private data stays team-private: `source` (the originating team's ids) is shown only to
 * site reviewers and the submitting team, never to catalog browsers; `scorecard` and
 * `authoritative_scorecard` hold aggregate numbers only, never case inputs, outputs or
 * transcripts ("eval transcripts never leave the team"). A rejected or withdrawn submission keeps
 * its manifest and summary in the Registry: submitting is the act of promotion (SK19).
 */
export const registryVersions = pgTable(
  "registry_versions",
  {
    id: uuid().primaryKey().defaultRandom(),
    skillId: uuid()
      .notNull()
      .references(() => registrySkills.id),
    semver: text().notNull(),
    seq: integer().notNull(),
    runtimeHash: text().notNull(),
    packageHash: text().notNull(),
    manifest: jsonb().$type<Record<string, unknown>>().notNull(),
    provenance: jsonb().$type<Record<string, unknown>>().notNull(),
    state: registryVersionState().notNull().default("submitted"),
    source: jsonb().$type<Record<string, unknown>>().notNull(),
    scan: jsonb().$type<Record<string, unknown>>().notNull(),
    verdict: scanVerdict().notNull(),
    scorecard: jsonb().$type<Record<string, unknown>>(),
    /** The Registry team's re-run with the Site judge (SK23): the catalog's scorecard. */
    authoritativeScorecard: jsonb().$type<Record<string, unknown>>(),
    submittedBy: uuid()
      .notNull()
      .references(() => users.id),
    submittedAt: ts().notNull().defaultNow(),
    /** The reviewer holding the item (SK23); null when unclaimed. */
    claimedBy: uuid().references(() => users.id),
    claimedAt: ts(),
    reviewedBy: uuid().references(() => users.id),
    approvedAt: ts(),
    /**
     * The submitter approved alone (SK22): the Site had no other active admin and no skill
     * reviewer. Set by the database only (`registry_versions_review_guard`).
     */
    selfApproved: boolean().notNull().default(false),
    /**
     * A rescan on a rule-set change turned this published version Block (KOBE-313, SK32): it is
     * suspended (omitted at resolve) pending review. The scan's `rulesVersion` names the rule set.
     */
    suspendedAt: ts(),
    /** Git mirror status of an approved version (SK29, optional). */
    mirror: jsonb().$type<Record<string, unknown>>(),
    updatedAt: ts().notNull().defaultNow(),
  },
  (t) => [
    unique("registry_versions_semver_unique").on(t.skillId, t.semver),
    unique("registry_versions_seq_unique").on(t.skillId, t.seq),
    // Team installs name (version, skill) together, so a version always belongs to its skill.
    unique("registry_versions_id_skill_unique").on(t.id, t.skillId),
    index("registry_versions_state_idx").on(t.state, t.submittedAt),
    index("registry_versions_runtime_idx").on(t.runtimeHash),
    index("registry_versions_package_idx").on(t.packageHash),
    check("registry_versions_semver_format", sql`${t.semver} ~ ${sql.raw(`'${SEMVER_FORMAT}'`)}`),
    check("registry_versions_seq_positive", sql`${t.seq} > 0`),
    check(
      "registry_versions_hashes",
      sql`${t.runtimeHash} ~ ${sql.raw(`'${SKILL_HASH_SQL}'`)} AND ${t.packageHash} ~ ${sql.raw(`'${SKILL_HASH_SQL}'`)}`,
    ),
    check(
      "registry_versions_documents",
      sql`${jsonObject(t.manifest)} AND ${jsonObject(t.provenance)} AND ${jsonObject(t.source)} AND ${jsonObject(t.scan)}
        AND (${t.scorecard} IS NULL OR ${jsonObject(t.scorecard)})
        AND (${t.authoritativeScorecard} IS NULL OR ${jsonObject(t.authoritativeScorecard)})
        AND (${t.mirror} IS NULL OR ${jsonObject(t.mirror)})`,
    ),
    check("registry_versions_claim", sql`(${t.claimedBy} IS NULL) = (${t.claimedAt} IS NULL)`),
    // Separation of duties (SK22): a review by the submitter is a flagged self-approval, and only
    // an approval (a submitter withdraws rather than rejects their own submission).
    check(
      "registry_versions_review",
      sql`${t.reviewedBy} IS NULL OR (${t.reviewedBy} = ${t.submittedBy}) = ${t.selfApproved}`,
    ),
    check(
      "registry_versions_self_approval",
      sql`NOT ${t.selfApproved} OR ${t.approvedAt} IS NOT NULL`,
    ),
    // A version that was ever published carries its approval; one that wasn't, none.
    check(
      "registry_versions_approval",
      sql`(${t.state} IN ('approved', 'deprecated', 'withdrawn', 'revoked'))
        = (${t.approvedAt} IS NOT NULL AND ${t.reviewedBy} IS NOT NULL)`,
    ),
  ],
);

/** Site-wide (†): the append-only history of a version's review (SK23) and retirement (SK31). */
export const registryReviewEvents = pgTable(
  "registry_review_events",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    versionId: uuid()
      .notNull()
      .references(() => registryVersions.id),
    actorId: uuid()
      .notNull()
      .references(() => users.id),
    action: registryReviewAction().notNull(),
    note: text(),
    checklist: jsonb().$type<Record<string, unknown>>(),
    at: ts().notNull().defaultNow(),
  },
  (t) => [
    index("registry_review_events_version_idx").on(t.versionId, t.at),
    index("registry_review_events_actor_idx").on(t.actorId, t.at),
    check(
      "registry_review_events_note_size",
      sql`${t.note} IS NULL OR char_length(${t.note}) BETWEEN 1 AND ${sql.raw(String(NOTE_MAX))}`,
    ),
    check(
      "registry_review_events_checklist",
      sql`${t.checklist} IS NULL OR ${jsonObject(t.checklist)}`,
    ),
  ],
);

/**
 * Site-wide (†): the tag vocabulary (SK5). System tags are a fixed, code-defined set (v1.2:
 * `default`, seeded by migration 0133; the check refuses any other system name; a trigger refuses
 * the app role, and the owner outside restore and migrations, deleting, truncating or changing
 * one); topic tags are managed by Site admins and retired, never deleted.
 */
export const registryTags = pgTable(
  "registry_tags",
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    kind: registryTagKind().notNull(),
    status: registryTagStatus().notNull().default("active"),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [
    unique("registry_tags_name_unique").on(t.name),
    check("registry_tags_name_format", sql`${t.name} ~ ${sql.raw(`'${TAG_FORMAT}'`)}`),
    check(
      "registry_tags_system_set",
      sql`${t.kind} <> 'system' OR (${t.name} IN (${sql.raw(SYSTEM_TAG_NAMES.map((n) => `'${n}'`).join(", "))}) AND ${t.status} = 'active')`,
    ),
  ],
);

/** Site-wide (†): tags on catalog skills (not versions, SK5). */
export const registrySkillTags = pgTable(
  "registry_skill_tags",
  {
    skillId: uuid()
      .notNull()
      .references(() => registrySkills.id),
    tagId: uuid()
      .notNull()
      .references(() => registryTags.id),
    addedBy: uuid()
      .notNull()
      .references(() => users.id),
    addedAt: ts().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.skillId, t.tagId] }),
    index("registry_skill_tags_tag_idx").on(t.tagId),
  ],
);

/**
 * Site-wide (†), one row (seeded): Registry settings (SK20, SK21, SK17, SK29, SK30, SK32). The
 * Registry team is an existing team; until it is named the Registry is "not ready" and Approve
 * is disabled. The JSON documents' shapes are owned by the tickets that use them.
 */
export const siteSkillSettings = pgTable(
  "site_skill_settings",
  {
    id: smallint().primaryKey().default(1),
    submissionRules: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    // SET NULL: deleting the Registry team leaves the Registry "not ready", never dangling.
    registryTeamId: uuid().references(() => teams.id, { onDelete: "set null" }),
    judgeAlias: text(),
    importAllowlist: jsonb().$type<unknown[]>().notNull().default([]),
    mirror: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    scanner: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    evalLimits: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    updatedBy: uuid().references(() => users.id),
    updatedAt: ts().notNull().defaultNow(),
  },
  (t) => [
    check("site_skill_settings_singleton", sql`${t.id} = 1`),
    check(
      "site_skill_settings_documents",
      sql`${jsonObject(t.submissionRules)} AND jsonb_typeof(${t.importAllowlist}) = 'array'
        AND ${jsonObject(t.mirror)} AND ${jsonObject(t.scanner)} AND ${jsonObject(t.evalLimits)}`,
    ),
    check(
      "site_skill_settings_judge_alias",
      sql`${t.judgeAlias} IS NULL OR char_length(${t.judgeAlias}) BETWEEN 1 AND 64`,
    ),
  ],
);
