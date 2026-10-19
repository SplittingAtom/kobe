import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { teams } from "./teams.js";

// Skill eval runs (KOBE-325, spec SK16, SK18; contract KOBE-324 `@kobe/protocol` skill-evals).
// Team tables: team_id NOT NULL, ENABLE + FORCE RLS with the canonical policy and a break-glass
// read (custom migration `*_skill_evals_rls.sql`). An eval run evaluates one package (a draft's
// revision or a saved version) and plans executions; each execution is one ordinary run in its
// own eval thread (`threads.skill_eval`) and its own ephemeral sandbox (wire slot `e-<thread>`,
// connection in `sandbox_eval_connections`).
// The rows hold the scorecard and per-case detail (judge reasons, thread ids): team content that
// never leaves the team. They follow team retention (by start) and offboarding (the starter's).
//
// Legal hold (D18): a hold never refuses or shows itself. Nobody deletes eval runs by hand; a
// purge's delete of a run whose starter a hold covers is skipped silently (a row trigger), so the
// run and its results stay until no hold covers the starter; TRUNCATE is refused while any hold
// is active.

/** Mirror `SKILL_EVAL_MODES` / `SKILL_EVAL_RUN_STATUSES` of `@kobe/protocol` (a server test). */
export const SKILL_EVAL_RUN_MODES = ["full", "with_only"] as const;
export const SKILL_EVAL_RUN_STATES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "budget_stopped",
] as const;
export type SkillEvalRunState = (typeof SKILL_EVAL_RUN_STATES)[number];
/** Where one execution is: waiting for a slot, its sandbox starting, its run, its checks, done. */
export const SKILL_EVAL_RESULT_STATES = [
  "queued",
  "starting",
  "running",
  "collecting",
  "done",
] as const;
export type SkillEvalResultState = (typeof SKILL_EVAL_RESULT_STATES)[number];
export const SKILL_EVAL_SUBJECT_KINDS = ["draft", "team", "personal"] as const;
export type SkillEvalSubjectKind = (typeof SKILL_EVAL_SUBJECT_KINDS)[number];
/** 25 cases, each with and without the skill (the contract's ceiling). */
export const SKILL_EVAL_MAX_EXECUTIONS = 50;

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));
const ts = () => timestamp({ withTimezone: true });
const SHA256 = "^[0-9a-f]{64}$";
const CASE_ID = "^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$";
const TERMINAL = list(["completed", "failed", "cancelled", "budget_stopped"]);

/**
 * Team table: one eval run. The subject is a draft's revision (`subject_id` the draft, `subject_rev`
 * its rev) or a saved version (`subject_id` the team or personal skill, `subject_rev` its seq); no
 * foreign key, so an eval outlives a deleted draft as history. `suite` is the parsed
 * `evals/cases.yaml` and `bundle_key` the stored runtime zip it ran (scanned at start). Only a
 * completed run has a scorecard; a failed or budget-stopped one has a failure.
 */
export const skillEvalRuns = pgTable(
  "skill_eval_runs",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    id: uuid().notNull().defaultRandom(),
    startedBy: uuid()
      .notNull()
      .references(() => users.id),
    subjectKind: text().$type<SkillEvalSubjectKind>().notNull(),
    subjectId: uuid().notNull(),
    subjectRev: integer().notNull(),
    skillName: text().notNull(),
    packageHash: text().notNull(),
    runtimeHash: text().notNull(),
    /**
     * Object key of the scanned runtime zip the "with" executions load, in the eval's own tree
     * (`<prefix>teams/<team>/skill-evals/<id>/`).
     */
    bundleKey: text().notNull(),
    /** Its size in bytes (the run.start's `skill_bundles` entry; the fetch is checked against it). */
    bundleSize: integer().notNull(),
    /**
     * Object key of the fixtures zip (`evals/` files the cases name) unpacked into each execution's
     * workspace, in the same tree; null when no case has fixtures. Never part of the runtime zip.
     * Purges (retention, offboarding) delete a run's objects only for the rows their
     * `DELETE … RETURNING bundle_key, fixtures_key` returned: the silent hold skips a held row, and
     * its objects stay with it.
     */
    fixturesKey: text(),
    mode: text().$type<(typeof SKILL_EVAL_RUN_MODES)[number]>().notNull(),
    status: text().$type<SkillEvalRunState>().notNull().default("queued"),
    suite: jsonb().$type<Record<string, unknown>>().notNull(),
    limits: jsonb().$type<Record<string, unknown>>().notNull(),
    runModel: jsonb().$type<Record<string, unknown>>(),
    judgeModel: jsonb().$type<Record<string, unknown>>(),
    progressTotal: integer().notNull(),
    progressDone: integer().notNull().default(0),
    scorecard: jsonb().$type<Record<string, unknown>>(),
    failure: jsonb().$type<Record<string, unknown>>(),
    cancelRequestedAt: ts(),
    startedAt: ts().notNull().defaultNow(),
    finishedAt: ts(),
    updatedAt: ts().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    // The history per subject (KOBE-328), newest first.
    index("skill_eval_runs_subject_idx").on(t.teamId, t.subjectKind, t.subjectId, t.startedAt),
    // The runner's queue: open runs only.
    index("skill_eval_runs_open_idx")
      .on(t.teamId, t.startedAt)
      .where(sql`${t.status} IN ('queued', 'running')`),
    index("skill_eval_runs_starter_idx").on(t.teamId, t.startedBy),
    check(
      "skill_eval_runs_subject_kind",
      sql`${t.subjectKind} IN (${list(SKILL_EVAL_SUBJECT_KINDS)})`,
    ),
    check("skill_eval_runs_subject_rev", sql`${t.subjectRev} >= 1`),
    check("skill_eval_runs_mode", sql`${t.mode} IN (${list(SKILL_EVAL_RUN_MODES)})`),
    check("skill_eval_runs_status", sql`${t.status} IN (${list(SKILL_EVAL_RUN_STATES)})`),
    check("skill_eval_runs_name", sql`${t.skillName} ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'`),
    check(
      "skill_eval_runs_hashes",
      sql`${t.packageHash} ~ '${sql.raw(SHA256)}' AND ${t.runtimeHash} ~ '${sql.raw(SHA256)}'`,
    ),
    check(
      "skill_eval_runs_keys",
      sql`char_length(${t.bundleKey}) BETWEEN 1 AND 512 AND ${t.bundleSize} > 0
        AND (${t.fixturesKey} IS NULL OR char_length(${t.fixturesKey}) BETWEEN 1 AND 512)`,
    ),
    check(
      "skill_eval_runs_json",
      sql`jsonb_typeof(${t.suite}) = 'object' AND jsonb_typeof(${t.limits}) = 'object'
        AND (${t.runModel} IS NULL OR jsonb_typeof(${t.runModel}) = 'object')
        AND (${t.judgeModel} IS NULL OR jsonb_typeof(${t.judgeModel}) = 'object')
        AND (${t.scorecard} IS NULL OR jsonb_typeof(${t.scorecard}) = 'object')
        AND (${t.failure} IS NULL OR jsonb_typeof(${t.failure}) = 'object')`,
    ),
    check(
      "skill_eval_runs_progress",
      sql`${t.progressDone} >= 0 AND ${t.progressDone} <= ${t.progressTotal}
        AND ${t.progressTotal} BETWEEN 1 AND ${sql.raw(String(SKILL_EVAL_MAX_EXECUTIONS))}`,
    ),
    check(
      "skill_eval_runs_outcome",
      sql`(${t.scorecard} IS NOT NULL) = (${t.status} = 'completed')
        AND (${t.failure} IS NOT NULL) = (${t.status} IN ('failed', 'budget_stopped'))
        AND (${t.finishedAt} IS NOT NULL) = (${t.status} IN (${TERMINAL}))`,
    ),
    check(
      "skill_eval_runs_scorecard_size",
      sql`${t.scorecard} IS NULL OR pg_column_size(${t.scorecard}) <= 1048576`,
    ),
  ],
);

/**
 * Team table: one execution (a case with or without the skill). `attempt` 2 is the automatic
 * retry, in a new thread and sandbox; `first_attempt` keeps what the first one cost. `thread_id`
 * is the current attempt's eval thread (SQL-only, custom migration: foreign key ON DELETE SET
 * NULL, and a row trigger that requires an eval thread of this same eval run); `deadline_at` the end of its wall clock, after which the reaper ends it. `execution`
 * is the final `SkillEvalExecution` (KOBE-324), set exactly when the row is done.
 */
export const skillEvalResults = pgTable(
  "skill_eval_results",
  {
    teamId: uuid().notNull(),
    evalRunId: uuid().notNull(),
    caseId: text().notNull(),
    withSkill: boolean().notNull(),
    state: text().$type<SkillEvalResultState>().notNull().default("queued"),
    attempt: smallint().notNull().default(1),
    threadId: uuid(),
    runId: uuid(),
    deadlineAt: ts(),
    firstAttempt: jsonb().$type<Record<string, unknown>>(),
    execution: jsonb().$type<Record<string, unknown>>(),
    startedAt: ts(),
    finishedAt: ts(),
    updatedAt: ts().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.evalRunId, t.caseId, t.withSkill] }),
    foreignKey({
      name: "skill_eval_results_run_fk",
      columns: [t.teamId, t.evalRunId],
      foreignColumns: [skillEvalRuns.teamId, skillEvalRuns.id],
    }).onDelete("cascade"),
    // The runner's work and the reaper's deadlines: unfinished executions only.
    index("skill_eval_results_open_idx")
      .on(t.teamId, t.state)
      .where(sql`${t.state} <> 'done'`),
    index("skill_eval_results_thread_idx")
      .on(t.teamId, t.threadId)
      .where(sql`${t.threadId} IS NOT NULL`),
    check("skill_eval_results_case_id", sql`${t.caseId} ~ '${sql.raw(CASE_ID)}'`),
    check("skill_eval_results_state", sql`${t.state} IN (${list(SKILL_EVAL_RESULT_STATES)})`),
    check("skill_eval_results_attempt", sql`${t.attempt} IN (1, 2)`),
    check(
      "skill_eval_results_done",
      sql`(${t.execution} IS NOT NULL) = (${t.state} = 'done')
        AND (${t.finishedAt} IS NOT NULL) = (${t.state} = 'done')`,
    ),
    check(
      "skill_eval_results_json",
      sql`(${t.execution} IS NULL OR jsonb_typeof(${t.execution}) = 'object')
        AND (${t.firstAttempt} IS NULL OR jsonb_typeof(${t.firstAttempt}) = 'object')
        AND (${t.firstAttempt} IS NULL OR ${t.attempt} = 2)`,
    ),
    check(
      "skill_eval_results_live",
      sql`${t.state} IN ('queued', 'done') OR ${t.deadlineAt} IS NOT NULL`,
    ),
  ],
);
