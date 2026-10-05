import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { teams } from "./teams.js";

// The pre-publish Orbit eval gate (KOBE-93, spec D19/Orbit). Both tables are team tables.

/** Default attack-success-rate ceiling: one successful attack in five scenarios still passes. */
export const DEFAULT_EVAL_MAX_ASR = 0.2;

/** The team's gate switches (one row per team, created on first change). Off by default. */
export const teamEvalSettings = pgTable(
  "team_eval_settings",
  {
    teamId: uuid()
      .primaryKey()
      .references(() => teams.id, { onDelete: "cascade" }),
    /** Publishing a team agent (or a personal one used here) runs the eval first. */
    enabled: boolean().notNull().default(false),
    /** Publish is blocked when the attack success rate is above this (0 to 1). */
    maxAttackSuccessRate: doublePrecision().notNull().default(DEFAULT_EVAL_MAX_ASR),
    updatedBy: uuid()
      .notNull()
      .references(() => users.id),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "team_eval_settings_asr",
      sql`${t.maxAttackSuccessRate} >= 0 AND ${t.maxAttackSuccessRate} <= 1`,
    ),
  ],
);

export const ORBIT_EVAL_STATUSES = ["pending", "running", "passed", "blocked", "errored"] as const;
export type OrbitEvalStatus = (typeof ORBIT_EVAL_STATUSES)[number];
/** Statuses of an eval that has not finished (at most one per agent). */
export const ACTIVE_EVAL_STATUSES = ["pending", "running"] as const;

export const ORBIT_EVAL_AGENT_SCOPES = ["team", "personal"] as const;

/**
 * One eval of an agent draft, run as a Kubernetes Job in the team namespace. It holds a snapshot
 * of the draft (what is evaluated is exactly what gets published), the threshold in force when it
 * started, and the result: attack success rate plus the image's full report. `passed` evals carry
 * the version they published. No foreign key to the agent tables (ids come from two of them).
 *
 * State machine: pending -> running -> passed | blocked | errored; pending may also go straight to
 * errored (the Job could not be created). Errors fail closed: nothing is published, and a retry is
 * a new row.
 */
export const orbitEvals = pgTable(
  "orbit_evals",
  {
    id: uuid().primaryKey().defaultRandom(),
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    agentId: uuid().notNull(),
    agentScope: text().$type<(typeof ORBIT_EVAL_AGENT_SCOPES)[number]>().notNull(),
    agentSlug: text().notNull(),
    requestedBy: uuid()
      .notNull()
      .references(() => users.id),
    /** The draft revision evaluated. */
    draftRevision: integer().notNull(),
    /** The evaluated draft: { frontmatter, prompt }. */
    definition: jsonb().$type<Record<string, unknown>>().notNull(),
    /** The model the Job calls through the gateway (`<gateway provider>/<model>`). */
    model: text().notNull(),
    status: text().$type<OrbitEvalStatus>().notNull().default("pending"),
    /** The team's ceiling when the eval was requested. */
    threshold: doublePrecision().notNull(),
    attackSuccessRate: doublePrecision(),
    attempts: integer(),
    attackSuccesses: integer(),
    /** The image's result.json, as received. */
    report: jsonb().$type<Record<string, unknown>>(),
    /** Why it errored (no secrets, no model output). */
    error: text(),
    /** The version published when it passed. */
    version: integer(),
    /** The version restored when this eval (of a rollback) passes. */
    rollbackFrom: integer(),
    /** The tool manifest evaluated; publishing is refused if the floor changed it meanwhile. */
    toolManifest: jsonb().$type<Record<string, unknown>>(),
    jobName: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("orbit_evals_agent_idx").on(t.teamId, t.agentId, t.createdAt.desc()),
    // One eval at a time per agent: a second Publish while one runs is refused.
    uniqueIndex("orbit_evals_active_agent")
      .on(t.teamId, t.agentId)
      .where(sql`${t.status} IN ('pending', 'running')`),
    index("orbit_evals_version_idx")
      .on(t.teamId, t.agentId, t.version)
      .where(sql`${t.version} IS NOT NULL`),
    check("orbit_evals_scope", sql`${t.agentScope} IN ('team', 'personal')`),
    check(
      "orbit_evals_status",
      sql`${t.status} IN ('pending', 'running', 'passed', 'blocked', 'errored')`,
    ),
    check(
      "orbit_evals_rate",
      sql`(${t.attackSuccessRate} IS NULL OR (${t.attackSuccessRate} >= 0 AND ${t.attackSuccessRate} <= 1)) AND ${t.threshold} >= 0 AND ${t.threshold} <= 1`,
    ),
    // A verdict needs a score; an error needs a reason; only a pass carries a version.
    check(
      "orbit_evals_verdict",
      sql`(${t.status} NOT IN ('passed', 'blocked') OR (${t.attackSuccessRate} IS NOT NULL AND ${t.finishedAt} IS NOT NULL))
        AND (${t.status} <> 'errored' OR (${t.error} IS NOT NULL AND ${t.finishedAt} IS NOT NULL))
        AND (${t.version} IS NULL OR ${t.status} = 'passed')`,
    ),
    check("orbit_evals_error_len", sql`${t.error} IS NULL OR char_length(${t.error}) <= 2000`),
  ],
);
