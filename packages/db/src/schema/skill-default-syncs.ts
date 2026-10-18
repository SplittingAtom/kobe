import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { registrySkills, registryVersions } from "./registry.js";

/**
 * What a Default sync does to every team (KOBE-314, SK6–SK8): `add` installs the skill (On by
 * default, Track within major, origin `default_tag`) except where the team opted out; `remove`
 * turns tag-made installs into team installs and clears opt-outs; `move_major` moves untouched
 * Default installs (origin `default_tag`, still Track within major) to a new major.
 */
export const DEFAULT_SYNC_KINDS = ["add", "remove", "move_major"] as const;
export type DefaultSyncKind = (typeof DEFAULT_SYNC_KINDS)[number];
export const DEFAULT_SYNC_STATUSES = ["queued", "running", "done"] as const;
export type DefaultSyncStatus = (typeof DEFAULT_SYNC_STATUSES)[number];

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));
const ts = () => timestamp({ withTimezone: true });

/**
 * Site-wide (†): one Default sync job (KOBE-314). Jobs run one at a time in the order they were
 * queued, on the replica holding the Default sync lease (a session advisory lock). Teams are walked
 * in id order; `after_team_id` is the cursor, written with the counts after every team, so a
 * crashed job resumes where it stopped and every per-team step is idempotent. Counts and ids only.
 */
export const skillDefaultSyncs = pgTable(
  "skill_default_syncs",
  {
    id: uuid().primaryKey().defaultRandom(),
    skillId: uuid()
      .notNull()
      .references(() => registrySkills.id),
    kind: text().$type<DefaultSyncKind>().notNull(),
    /** The major Default installs follow after this job (`add`, `move_major`); null for `remove`. */
    major: integer(),
    /** The version new Default installs get (`add`) or moved installs move to (`move_major`). */
    versionId: uuid(),
    status: text().$type<DefaultSyncStatus>().notNull().default("queued"),
    requestedBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: ts().notNull().defaultNow(),
    startedAt: ts(),
    finishedAt: ts(),
    /** Teams when the job started, and teams done so far (the console's progress). */
    teamsTotal: integer().notNull().default(0),
    teamsDone: integer().notNull().default(0),
    afterTeamId: uuid(),
    /** `add`: new installs; teams that already had one (kept their settings); opted-out teams. */
    installed: integer().notNull().default(0),
    kept: integer().notNull().default(0),
    optedOut: integer().notNull().default(0),
    /** `remove`: tag-made installs turned into team installs, and opt-outs cleared. */
    converted: integer().notNull().default(0),
    optoutsCleared: integer().notNull().default(0),
    /** `move_major`: installs moved to the new major. */
    moved: integer().notNull().default(0),
  },
  (t) => [
    // The version is one of this skill's.
    foreignKey({
      name: "skill_default_syncs_version_fk",
      columns: [t.versionId, t.skillId],
      foreignColumns: [registryVersions.id, registryVersions.skillId],
    }),
    index("skill_default_syncs_queue_idx").on(t.status, t.createdAt),
    index("skill_default_syncs_skill_idx").on(t.skillId, t.createdAt),
    check("skill_default_syncs_kind", sql`${t.kind} IN (${list(DEFAULT_SYNC_KINDS)})`),
    check("skill_default_syncs_status", sql`${t.status} IN (${list(DEFAULT_SYNC_STATUSES)})`),
    check(
      "skill_default_syncs_target",
      sql`(${t.kind} = 'remove') = (${t.major} IS NULL AND ${t.versionId} IS NULL)
        AND (${t.major} IS NULL OR ${t.major} >= 0)`,
    ),
    check(
      "skill_default_syncs_times",
      sql`(${t.status} = 'queued') = (${t.startedAt} IS NULL)
        AND (${t.status} = 'done') = (${t.finishedAt} IS NOT NULL)`,
    ),
    check(
      "skill_default_syncs_counts",
      sql`${t.teamsTotal} >= 0 AND ${t.teamsDone} >= 0 AND ${t.installed} >= 0 AND ${t.kept} >= 0
        AND ${t.optedOut} >= 0 AND ${t.converted} >= 0 AND ${t.optoutsCleared} >= 0
        AND ${t.moved} >= 0`,
    ),
  ],
);
