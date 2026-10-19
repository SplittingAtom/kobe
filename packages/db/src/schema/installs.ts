import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { registrySkills, registryVersions } from "./registry.js";
import { personalSkills, skillAccess, teamSkills } from "./skills.js";
import { teamMembers } from "./team-members.js";
import { teams } from "./teams.js";

// What teams and members run from the Site Skills Catalog (KOBE-311, spec SK6–SK8, SK25). Team
// tables: team_id NOT NULL, ENABLE + FORCE RLS with the canonical policy (custom migration). They
// reference the site-wide catalog (no cascade from it: catalog rows are never deleted) and their
// own team. The closed sets mirror `@kobe/protocol` skill-catalog.ts.

export const skillPinMode = pgEnum("skill_pin_mode", ["pinned", "within_major", "latest"]);
export type SkillPinModeValue = (typeof skillPinMode.enumValues)[number];
export const skillInstallOrigin = pgEnum("skill_install_origin", ["team", "default_tag"]);

const REASON_MAX = 500;
const ts = () => timestamp({ withTimezone: true });

/** Team table: the team's install of a catalog skill, at a version, pin mode and access (SK25). */
export const teamSkillInstalls = pgTable(
  "team_skill_installs",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    skillId: uuid()
      .notNull()
      .references(() => registrySkills.id),
    versionId: uuid().notNull(),
    pinMode: skillPinMode().notNull(),
    access: skillAccess().notNull(),
    /** `default_tag`: made by the Default tag (SK6); the team's later changes stick. */
    origin: skillInstallOrigin().notNull().default("team"),
    // Users are deactivated, never deleted (NO ACTION); a Default install names who tagged it,
    // or no one when Kobe's own Default sync made it (`by_kobe`, KOBE-317).
    installedBy: uuid().references(() => users.id),
    byKobe: boolean().notNull().default(false),
    /**
     * When the team last changed the install's pin mode, access or origin (KOBE-314): set, the
     * install is "touched" and a Site admin's move of Default installs to a new major skips it;
     * the team's choice sticks (SK6). Null: as the Default tag made it.
     */
    teamChangedAt: ts(),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.skillId] }),
    // The version is one of this skill's (registry_versions (id, skill_id) is unique).
    foreignKey({
      name: "team_skill_installs_version_fk",
      columns: [t.versionId, t.skillId],
      foreignColumns: [registryVersions.id, registryVersions.skillId],
    }),
    index("team_skill_installs_skill_idx").on(t.skillId),
    check("team_skill_installs_by_kobe", sql`${t.byKobe} = (${t.installedBy} IS NULL)`),
  ],
);

/** Team table: a sticky opt-out of a Default skill (SK7); Default syncs skip it. */
export const teamSkillOptouts = pgTable(
  "team_skill_optouts",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    skillId: uuid()
      .notNull()
      .references(() => registrySkills.id),
    optedOutBy: uuid()
      .notNull()
      .references(() => users.id),
    reason: text(),
    at: ts().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.skillId] }),
    check(
      "team_skill_optouts_reason_size",
      sql`${t.reason} IS NULL OR char_length(${t.reason}) BETWEEN 1 AND ${sql.raw(String(REASON_MAX))}`,
    ),
  ],
);

/** Team table: a catalog skill a Team admin blocked in the team (SK25): no member adds. */
export const teamSkillBlocks = pgTable(
  "team_skill_blocks",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    skillId: uuid()
      .notNull()
      .references(() => registrySkills.id),
    blockedBy: uuid()
      .notNull()
      .references(() => users.id),
    at: ts().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.skillId] })],
);

/**
 * Team table: a member's own choice about one skill in one team (SK25, SK27): an Add for me of a
 * catalog skill (with its version and pin mode), turning a team skill or install (On by default)
 * off or (Available) on, or turning one of their personal skills off or on in this team (KOBE-316;
 * no row = on, D22). Exactly one of `catalog_skill_id` / `team_skill_id` / `personal_skill_id`
 * names the skill, each with a real foreign key: a version always belongs to the named catalog
 * skill, a team skill is this team's, and a personal skill is this member's own (composite FKs,
 * cascade). Leaves with the membership (cascade from `team_members`). A Team
 * admin's block of a catalog skill removes the members' adds of it and refuses new ones
 * (triggers, migration 0133).
 */
export const memberSkillEnablements = pgTable(
  "member_skill_enablements",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    id: uuid().notNull().defaultRandom(),
    userId: uuid().notNull(),
    catalogSkillId: uuid().references(() => registrySkills.id),
    teamSkillId: uuid(),
    personalSkillId: uuid(),
    enabled: boolean().notNull(),
    versionId: uuid(),
    pinMode: skillPinMode(),
    updatedAt: ts().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    uniqueIndex("member_skill_enablements_catalog_unique")
      .on(t.teamId, t.userId, t.catalogSkillId)
      .where(sql`${t.catalogSkillId} IS NOT NULL`),
    uniqueIndex("member_skill_enablements_team_unique")
      .on(t.teamId, t.userId, t.teamSkillId)
      .where(sql`${t.teamSkillId} IS NOT NULL`),
    uniqueIndex("member_skill_enablements_personal_unique")
      .on(t.teamId, t.userId, t.personalSkillId)
      .where(sql`${t.personalSkillId} IS NOT NULL`),
    foreignKey({
      name: "member_skill_enablements_member_fk",
      columns: [t.teamId, t.userId],
      foreignColumns: [teamMembers.teamId, teamMembers.userId],
    }).onDelete("cascade"),
    foreignKey({
      name: "member_skill_enablements_team_skill_fk",
      columns: [t.teamId, t.teamSkillId],
      foreignColumns: [teamSkills.teamId, teamSkills.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "member_skill_enablements_personal_skill_fk",
      columns: [t.personalSkillId, t.userId],
      foreignColumns: [personalSkills.id, personalSkills.ownerUserId],
    }).onDelete("cascade"),
    // The pinned version is one of the named catalog skill's.
    foreignKey({
      name: "member_skill_enablements_version_fk",
      columns: [t.versionId, t.catalogSkillId],
      foreignColumns: [registryVersions.id, registryVersions.skillId],
    }),
    check(
      "member_skill_enablements_one_skill",
      sql`num_nonnulls(${t.catalogSkillId}, ${t.teamSkillId}, ${t.personalSkillId}) = 1`,
    ),
    // A version and pin mode come together, and only for a catalog skill.
    check(
      "member_skill_enablements_pin",
      sql`(${t.versionId} IS NULL) = (${t.pinMode} IS NULL)
        AND (${t.versionId} IS NULL OR ${t.catalogSkillId} IS NOT NULL)`,
    ),
  ],
);

/**
 * Team table: a member's Request for team of a catalog skill (KOBE-338, SK25): live state for the
 * Team console (listed, dismissed, rate-limited); the audit log keeps who asked and when. One row
 * per member and skill. `last_at` is when the member last asked (a repeat within a day is not a new
 * request, dismissed or not); a Team admin's Dismiss sets `dismissed_at`, and a later request clears
 * it. Installing or blocking the skill answers the requests (the rows are deleted); they leave with
 * the membership (cascade from `team_members`).
 */
export const teamSkillRequests = pgTable(
  "team_skill_requests",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    skillId: uuid()
      .notNull()
      .references(() => registrySkills.id),
    userId: uuid().notNull(),
    firstAt: ts().notNull().defaultNow(),
    lastAt: ts().notNull().defaultNow(),
    dismissedAt: ts(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.skillId, t.userId] }),
    foreignKey({
      name: "team_skill_requests_member_fk",
      columns: [t.teamId, t.userId],
      foreignColumns: [teamMembers.teamId, teamMembers.userId],
    }).onDelete("cascade"),
    // The console's open list, newest first, and a member's requests of the day (the cap).
    index("team_skill_requests_open_idx")
      .on(t.teamId, t.lastAt.desc())
      .where(sql`${t.dismissedAt} IS NULL`),
    index("team_skill_requests_member_idx").on(t.teamId, t.userId, t.lastAt),
    check("team_skill_requests_order", sql`${t.firstAt} <= ${t.lastAt}`),
  ],
);
