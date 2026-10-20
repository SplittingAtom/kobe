import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { registryVersions } from "./registry.js";
import { teamSkills } from "./skills.js";
import { teams } from "./teams.js";

/** Mirrors `SKILL_PROMOTION_STATES` (@kobe/protocol). */
export const SKILL_PROMOTION_STATES = ["pending", "confirmed", "declined", "cancelled"] as const;
export type SkillPromotionState = (typeof SKILL_PROMOTION_STATES)[number];

const NOTE_MAX = 1000;

/**
 * Team table (RLS, KOBE-333, SK19): a Builder's **Promote to Site** of a team skill version, in the
 * team's review queue until a Team admin confirms (Kobe then submits it to the Registry) or
 * declines with a note. While a team has "Builders may promote without confirmation" on, a
 * Builder's promotion is submitted at once and no request is kept. One open request per version.
 */
export const skillPromotionRequests = pgTable(
  "skill_promotion_requests",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    id: uuid().notNull().defaultRandom(),
    skillId: uuid().notNull(),
    /** The team version (`team_skill_versions.version`, its seq) and its semver at request time. */
    version: integer().notNull(),
    semver: text().notNull(),
    /** The package the Builder saw: a newer save is a new request. */
    packageHash: text().notNull(),
    // Users are deactivated, never deleted (NO ACTION).
    requestedBy: uuid()
      .notNull()
      .references(() => users.id),
    state: text().$type<SkillPromotionState>().notNull().default("pending"),
    decidedBy: uuid().references(() => users.id),
    decidedAt: timestamp({ withTimezone: true }),
    /** A Team admin's note on a decline. */
    note: text(),
    /** The Registry version a confirmation submitted (site-wide; no cascade either way). */
    registryVersionId: uuid().references(() => registryVersions.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    foreignKey({
      name: "skill_promotion_requests_skill_fk",
      columns: [t.teamId, t.skillId],
      foreignColumns: [teamSkills.teamId, teamSkills.id],
    }).onDelete("cascade"),
    // The queue: open requests, oldest first.
    index("skill_promotion_requests_queue_idx").on(t.teamId, t.state, t.createdAt),
    uniqueIndex("skill_promotion_requests_open_uq")
      .on(t.teamId, t.skillId, t.version)
      .where(sql`${t.state} = 'pending'`),
    check(
      "skill_promotion_requests_state",
      sql`${t.state} IN ('pending', 'confirmed', 'declined', 'cancelled')`,
    ),
    check(
      "skill_promotion_requests_decision",
      sql`(${t.state} = 'pending') = (${t.decidedAt} IS NULL)
        AND (${t.decidedAt} IS NULL) = (${t.decidedBy} IS NULL)
        AND (${t.state} = 'confirmed') = (${t.registryVersionId} IS NOT NULL)`,
    ),
    check(
      "skill_promotion_requests_note",
      sql`${t.note} IS NULL OR char_length(${t.note}) BETWEEN 1 AND ${sql.raw(String(NOTE_MAX))}`,
    ),
    check("skill_promotion_requests_version", sql`${t.version} > 0`),
    check("skill_promotion_requests_hash", sql`${t.packageHash} ~ '^[0-9a-f]{64}$'`),
  ],
);
