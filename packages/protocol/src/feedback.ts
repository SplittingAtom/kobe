import { z } from "zod";
import { idSchema, timestampSchema, uuidSchema } from "./common.js";

/**
 * Answer feedback (KOBE-275). CONTRACT: a member's thumbs up or down on one answer (one run), an
 * optional reason set and an optional short comment on a thumbs down, and the per-version totals
 * agent owners and team admins read.
 *
 * - One rating per (run, member). Whoever can read the thread may rate it, for themselves: the
 *   owner and the readers of a project- or team-shared thread (KOBE-221). A rating is changed by
 *   rating again (`PUT`) and cleared with `DELETE`; nobody sees another member's rating.
 * - The comment is thread content: it stays with the thread (retention, Trash purge, legal hold,
 *   export, break-glass) and is shown to its author only. Totals carry counts, never text, and no
 *   per-member attribution.
 *
 * Routes (server):
 * - `PUT /v1/runs/{run_id}/feedback` ({@link putFeedbackBodySchema}) → {@link AnswerFeedback}
 * - `DELETE /v1/runs/{run_id}/feedback` → 204 (also when there was none)
 * - `GET /v1/threads/{thread_id}/feedback` → {@link ThreadFeedback} (rateable answers, own ratings)
 * - `GET /v1/agents/{agent_id}/feedback?window=7|30|90` → {@link AgentFeedbackTotals}
 */

export const FEEDBACK_RATINGS = ["up", "down"] as const;
export const feedbackRatingSchema = z.enum(FEEDBACK_RATINGS);
export type FeedbackRating = z.infer<typeof feedbackRatingSchema>;

/** Reason chips of a thumbs down, a closed set (KOBE-276 groups eval cases by them). */
export const FEEDBACK_REASONS = [
  "wrong",
  "ignored_instructions",
  "unsafe",
  "too_slow",
  "other",
] as const;
export const feedbackReasonSchema = z.enum(FEEDBACK_REASONS);
export type FeedbackReason = z.infer<typeof feedbackReasonSchema>;

/** Longest comment, in characters. */
export const FEEDBACK_COMMENT_MAX_CHARS = 500;

/** Printable text plus newlines and tabs: no NUL (jsonb and text refuse it), no other controls. */
// eslint-disable-next-line no-control-regex
const COMMENT_CHARS = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u;

export const feedbackCommentSchema = z
  .string()
  .trim()
  .min(1)
  .max(FEEDBACK_COMMENT_MAX_CHARS)
  .regex(COMMENT_CHARS, "no control characters");

/**
 * `PUT /v1/runs/{run_id}/feedback`. Reasons and the comment belong to a thumbs down only: a thumbs
 * up with either is refused (400), so changing down → up must send them empty. `entry_id` names
 * the answer's last entry the client showed (optional; it must be an entry of the run's thread).
 */
export const putFeedbackBodySchema = z
  .strictObject({
    rating: feedbackRatingSchema,
    reasons: z
      .array(feedbackReasonSchema)
      .max(FEEDBACK_REASONS.length)
      .refine((r) => new Set(r).size === r.length, "reasons must be distinct")
      .default([]),
    comment: feedbackCommentSchema.nullable().default(null),
    entry_id: idSchema.nullable().default(null),
  })
  .refine((b) => b.rating === "down" || (b.reasons.length === 0 && b.comment === null), {
    message: "reasons and comment go with a thumbs down only",
    path: ["rating"],
  });
export type PutFeedbackBody = z.infer<typeof putFeedbackBodySchema>;

/** A member's own rating of one answer. */
export const answerFeedbackSchema = z.strictObject({
  run_id: uuidSchema,
  thread_id: uuidSchema,
  entry_id: idSchema.nullable(),
  rating: feedbackRatingSchema,
  reasons: z.array(feedbackReasonSchema),
  comment: z.string().nullable(),
  updated_at: timestampSchema,
});
export type AnswerFeedback = z.infer<typeof answerFeedbackSchema>;

/**
 * `GET /v1/threads/{thread_id}/feedback`: every answer of the thread that can be rated (its ended
 * message runs, oldest first) with the caller's own rating or null. `user_entry_id` is the prompt
 * the run answered (`runs.user_entry_id`; null until Pi committed it), which is how the chat finds
 * the run behind an answer: each run sends its own prompt.
 */
export const threadFeedbackSchema = z.strictObject({
  thread_id: uuidSchema,
  answers: z.array(
    z.strictObject({
      run_id: uuidSchema,
      user_entry_id: idSchema.nullable(),
      feedback: answerFeedbackSchema.nullable(),
      /** The caller shared this rating as an eval case (KOBE-276): the case's id. */
      eval_case_id: uuidSchema.nullable().optional(),
    }),
  ),
});
export type ThreadFeedback = z.infer<typeof threadFeedbackSchema>;

/** Error codes of the feedback routes, with their HTTP status. */
export const FEEDBACK_ERROR_HTTP_STATUS = {
  invalid_request: 400,
  run_not_found: 404,
  thread_not_found: 404,
  entry_not_found: 404,
  agent_not_found: 404,
  forbidden: 403,
  run_not_ended: 409,
  not_an_answer: 409,
  thread_in_trash: 409,
  test_thread: 409,
} as const;
export type FeedbackErrorCode = keyof typeof FEEDBACK_ERROR_HTTP_STATUS;

/**
 * Fewest distinct raters, not counting the caller, behind any number the totals show (KOBE-275
 * review S1): a cell with fewer is withheld, so the totals never single out one member's ratings
 * or reasons. The caller's own ratings still count in the numbers: they know them anyway.
 */
export const FEEDBACK_MIN_RATERS = 5;

/**
 * Up and down counts; `rate` = up / (up + down). `enough` is false when fewer than
 * {@link FEEDBACK_MIN_RATERS} other members rated: then `up`, `down` and `rate` are null.
 */
export const feedbackCountsSchema = z.strictObject({
  enough: z.boolean(),
  up: z.number().int().nonnegative().nullable(),
  down: z.number().int().nonnegative().nullable(),
  rate: z.number().min(0).max(1).nullable(),
});
export type FeedbackCounts = z.infer<typeof feedbackCountsSchema>;

/** Thumbs-down reasons counted (one rating may give several). Every reason is present. */
export const feedbackReasonCountsSchema = z.strictObject(
  Object.fromEntries(FEEDBACK_REASONS.map((r) => [r, z.number().int().nonnegative()])) as Record<
    FeedbackReason,
    z.ZodNumber
  >,
);
export type FeedbackReasonCounts = z.infer<typeof feedbackReasonCountsSchema>;

const shownCountsSchema = z.strictObject({
  up: z.number().int().nonnegative(),
  down: z.number().int().nonnegative(),
  rate: z.number().min(0).max(1).nullable(),
});

/** The windows the totals offer: the last 7, 30 or 90 finished UTC days (default 30). */
export const FEEDBACK_WINDOWS_DAYS = [7, 30, 90] as const;
export type FeedbackWindowDays = (typeof FEEDBACK_WINDOWS_DAYS)[number];
export const FEEDBACK_DEFAULT_WINDOW_DAYS: FeedbackWindowDays = 30;

/** `GET /v1/agents/{agent_id}/feedback?window=7|30|90`: the only query it takes. */
export const feedbackTotalsQuerySchema = z.strictObject({
  window: z
    .enum(FEEDBACK_WINDOWS_DAYS.map(String) as ["7", "30", "90"])
    .transform((w) => Number(w) as FeedbackWindowDays)
    .optional(),
});

/**
 * `GET /v1/agents/{agent_id}/feedback?window=7|30|90`: ratings in the active team of answers by
 * this agent over the last 7, 30 or 90 finished UTC days (ending at the start of today), by
 * published version (builder test threads are never rated), model alias (null = unknown), reason
 * and day of the rating's last change.
 *
 * Counts only: no thread, run, member or comment is reachable through it. Small numbers would
 * single people out (review S1, R1, R2), so:
 * - only the preset windows: no custom range, so two queries can't be cut to a chosen day;
 * - `totals` shows numbers only over {@link FEEDBACK_MIN_RATERS} raters (else `enough: false`);
 * - a breakdown (the versions, a version's models, a version's reasons, the days) is shown only
 *   when every one of its non-empty cells has that many raters; otherwise it is null, "not enough
 *   ratings to break down", so no hidden cell can be worked out from the total and the rest.
 * Residual (accepted): comparing nested windows (7 vs 30 days), or the same window on different
 * days, can still narrow raters down over time; exact counts can't fully prevent that.
 */
export const agentFeedbackTotalsSchema = z.strictObject({
  agent_id: uuidSchema,
  from: timestampSchema,
  to: timestampSchema,
  window_days: z.union([z.literal(7), z.literal(30), z.literal(90)]),
  bucket: z.literal("day"),
  min_raters: z.number().int().positive(),
  totals: feedbackCountsSchema,
  versions: z
    .array(
      z.strictObject({
        version: z.number().int().positive().nullable(),
        ...shownCountsSchema.shape,
        reasons: feedbackReasonCountsSchema.nullable(),
        models: z
          .array(z.strictObject({ model: z.string().nullable(), ...shownCountsSchema.shape }))
          .nullable(),
      }),
    )
    .nullable(),
  series: z
    .array(
      z.strictObject({
        start: timestampSchema,
        up: z.number().int().nonnegative(),
        down: z.number().int().nonnegative(),
      }),
    )
    .nullable(),
});
export type AgentFeedbackTotals = z.infer<typeof agentFeedbackTotalsSchema>;
