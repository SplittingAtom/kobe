import { z } from "zod";
import { timestampSchema, uuidSchema } from "../common.js";
import { SHA256_HEX_PATTERN } from "../skill-package/layout.js";
import { EVAL_CASE_ID_PATTERN, EVAL_MAX_CASES } from "./cases.js";
import { SKILL_EVAL_MODES } from "./plan.js";
import { SKILL_EVAL_EXECUTION_STATUSES, skillEvalScorecardSchema } from "./scorecard.js";

/**
 * Eval runs over the API (KOBE-324 contract for KOBE-325..328; spec SK16–SK18). All routes are in
 * the caller's active team; an eval run, its executions' threads and its scorecard never leave
 * it (Registry re-runs happen in the Registry team, SK21).
 *
 * - `POST /v1/skills/drafts/{draft_id}/evals` ({@link startSkillEvalBodySchema}) → 202
 *   {@link SkillEvalStarted}: the draft's current revision (Workbench).
 * - `POST /v1/skills/{scope}/{skill_id}/versions/{seq}/evals` (same body) → 202: a saved version.
 * - `GET /v1/skill-evals/{eval_run_id}` → {@link SkillEvalRun}.
 * - `GET /v1/skill-evals?draft_id=…` or `?skill_id=…&scope=…` → `{ runs: SkillEvalRun[] }`,
 *   newest first: the history per version (KOBE-328).
 * - `POST /v1/skill-evals/{eval_run_id}/cancel` → 202.
 * - Stream events `skill.eval.progress` ({@link skillEvalProgressPayloadSchema}) and
 *   `skill.eval.completed` ({@link skillEvalCompletedPayloadSchema}): ids, statuses and numbers
 *   only. KOBE-325 picks the transport (the run's own SSE stream or the team notifications
 *   stream); the payloads are fixed here.
 */

/** `run_usage` kinds (SK18): the executions' model calls and the judge's. */
export const SKILL_EVAL_USAGE_KINDS = ["eval", "eval_judge"] as const;
export type SkillEvalUsageKind = (typeof SKILL_EVAL_USAGE_KINDS)[number];

/** What a run evaluates: a draft's revision, or a saved team or personal version. */
export const skillEvalSubjectSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("draft"), draftId: uuidSchema, rev: z.number().int().min(1) }),
  z.strictObject({
    kind: z.literal("version"),
    scope: z.enum(["team", "personal"]),
    skillId: uuidSchema,
    seq: z.number().int().min(1),
  }),
]);
export type SkillEvalSubject = z.infer<typeof skillEvalSubjectSchema>;

export const startSkillEvalBodySchema = z.strictObject({ mode: z.enum(SKILL_EVAL_MODES) });
export type StartSkillEvalBody = z.infer<typeof startSkillEvalBodySchema>;

/**
 * "≈ $X, ≈ N min" (SK18, KOBE-327): executions × the team's recent per-model averages. Null
 * numbers (`basis: none`) when the team has no history for the model yet.
 */
export const skillEvalEstimateSchema = z.strictObject({
  executions: z
    .number()
    .int()
    .min(1)
    .max(EVAL_MAX_CASES * 2),
  costUsd: z.number().min(0).nullable(),
  minutes: z.number().min(0).nullable(),
  basis: z.enum(["team_history", "none"]),
});
export type SkillEvalEstimate = z.infer<typeof skillEvalEstimateSchema>;

export const skillEvalStartedSchema = z.strictObject({
  evalRunId: uuidSchema,
  estimate: skillEvalEstimateSchema,
});
export type SkillEvalStarted = z.infer<typeof skillEvalStartedSchema>;

export const SKILL_EVAL_RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "budget_stopped",
] as const;
export type SkillEvalRunStatus = (typeof SKILL_EVAL_RUN_STATUSES)[number];

const failureSchema = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  message: z.string().min(1).max(500),
});

export const skillEvalRunSchema = z
  .strictObject({
    id: uuidSchema,
    subject: skillEvalSubjectSchema,
    packageHash: z.string().regex(SHA256_HEX_PATTERN),
    mode: z.enum(SKILL_EVAL_MODES),
    status: z.enum(SKILL_EVAL_RUN_STATUSES),
    progress: z.strictObject({ done: z.number().int().min(0), total: z.number().int().min(0) }),
    /** Present once the run completed. */
    scorecard: skillEvalScorecardSchema.nullable(),
    /** Why a run failed or stopped (a refused suite, the team eval cap, the budget). */
    failure: failureSchema.nullable(),
    startedBy: uuidSchema,
    startedAt: timestampSchema,
    finishedAt: timestampSchema.nullable(),
  })
  .superRefine((r, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (r.progress.done > r.progress.total) fail("done ≤ total");
    // Only a completed run has a scorecard: a cancelled or budget-stopped one is no evidence.
    if ((r.status === "completed") !== (r.scorecard !== null))
      fail("a scorecard exactly when completed");
    const stopped = r.status === "failed" || r.status === "budget_stopped";
    if (stopped !== (r.failure !== null)) fail("a failure exactly when failed or budget-stopped");
    const card = r.scorecard;
    if (!card) return;
    if (card.packageHash !== r.packageHash) fail("the scorecard is of the run's package");
    if (card.mode !== r.mode) fail("the scorecard is of the run's mode");
    const executions = card.details.reduce((n, d) => n + (d.without ? 2 : 1), 0);
    if (r.progress.total !== executions || r.progress.done !== executions)
      fail("progress counts the scorecard's executions");
  });
export type SkillEvalRun = z.infer<typeof skillEvalRunSchema>;

export const skillEvalProgressPayloadSchema = z.strictObject({
  evalRunId: uuidSchema,
  done: z.number().int().min(0),
  total: z.number().int().min(0),
  caseId: z.string().regex(EVAL_CASE_ID_PATTERN),
  withSkill: z.boolean(),
  status: z.enum(SKILL_EVAL_EXECUTION_STATUSES),
});
export type SkillEvalProgressPayload = z.infer<typeof skillEvalProgressPayloadSchema>;

const ratio = z.number().min(0).max(1);
export const skillEvalCompletedPayloadSchema = z.strictObject({
  evalRunId: uuidSchema,
  status: z.enum(SKILL_EVAL_RUN_STATUSES),
  passRate: ratio.nullable(),
  baselinePassRate: ratio.nullable(),
  lift: z.number().min(-1).max(1).nullable(),
});
export type SkillEvalCompletedPayload = z.infer<typeof skillEvalCompletedPayloadSchema>;

/**
 * `site_skill_settings.eval_limits` (SK18). The spec's numbers are the defaults and the ceilings
 * for cases and wall clock (a Site may lower them); concurrency is a Site default that lives
 * inside the team ResourceQuota either way.
 */
export const SKILL_EVAL_DEFAULT_LIMITS = {
  maxConcurrentSandboxes: 4,
  maxCases: EVAL_MAX_CASES,
  caseWallClockMinutes: 10,
} as const;

export const skillEvalLimitsSchema = z.strictObject({
  maxConcurrentSandboxes: z
    .number()
    .int()
    .min(1)
    .max(16)
    .default(SKILL_EVAL_DEFAULT_LIMITS.maxConcurrentSandboxes),
  maxCases: z.number().int().min(1).max(EVAL_MAX_CASES).default(SKILL_EVAL_DEFAULT_LIMITS.maxCases),
  caseWallClockMinutes: z
    .number()
    .int()
    .min(1)
    .max(SKILL_EVAL_DEFAULT_LIMITS.caseWallClockMinutes)
    .default(SKILL_EVAL_DEFAULT_LIMITS.caseWallClockMinutes),
});
export type SkillEvalLimits = z.infer<typeof skillEvalLimitsSchema>;

/** The optional monthly team eval cap (SK18, Team admin): dollars or tokens; null is none. */
/** Whole cents (the column is numeric(14,2): anything finer would be rounded, review-327 L4). */
const wholeCents = (v: number) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6;
export const TEAM_EVAL_CAP_USD_MESSAGE =
  "A dollar eval cap is at least $0.01, in whole cents, and at most $1,000,000.";

export const teamEvalCapSchema = z
  .union([
    z.strictObject({
      usd: z
        .number()
        .min(0.01, TEAM_EVAL_CAP_USD_MESSAGE)
        .max(1_000_000, TEAM_EVAL_CAP_USD_MESSAGE)
        .refine(wholeCents, TEAM_EVAL_CAP_USD_MESSAGE),
    }),
    z.strictObject({ tokens: z.number().int().min(1).max(1e12) }),
  ])
  .nullable();
export type TeamEvalCap = z.infer<typeof teamEvalCapSchema>;
