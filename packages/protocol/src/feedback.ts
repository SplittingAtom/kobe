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
 * - `GET /v1/threads/{thread_id}/feedback` → {@link ThreadFeedback} (the caller's own ratings)
 * - `GET /v1/agents/{agent_id}/feedback?from&to&bucket` → {@link AgentFeedbackTotals}
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

/** `GET /v1/threads/{thread_id}/feedback`: the caller's ratings in the thread, newest first. */
export const threadFeedbackSchema = z.strictObject({
  thread_id: uuidSchema,
  feedback: z.array(answerFeedbackSchema),
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
  legal_hold: 409,
} as const;
export type FeedbackErrorCode = keyof typeof FEEDBACK_ERROR_HTTP_STATUS;

/** Up and down counts; `rate` = up / (up + down), null with no ratings. */
export const feedbackCountsSchema = z.strictObject({
  up: z.number().int().nonnegative(),
  down: z.number().int().nonnegative(),
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

/**
 * `GET /v1/agents/{agent_id}/feedback`: ratings in the active team of answers by this agent, per
 * published version (builder test threads are never rated), by model alias (null = unknown) and per
 * time bucket of the rating's last change. Counts only: no thread, run, member or comment is
 * reachable through it.
 */
export const agentFeedbackTotalsSchema = z.strictObject({
  agent_id: uuidSchema,
  from: timestampSchema,
  to: timestampSchema,
  bucket: z.enum(["hour", "day"]),
  totals: feedbackCountsSchema,
  versions: z.array(
    z.strictObject({
      version: z.number().int().positive().nullable(),
      ...feedbackCountsSchema.shape,
      reasons: feedbackReasonCountsSchema,
      models: z.array(
        z.strictObject({ model: z.string().nullable(), ...feedbackCountsSchema.shape }),
      ),
    }),
  ),
  series: z.array(z.strictObject({ start: timestampSchema, up: z.number(), down: z.number() })),
});
export type AgentFeedbackTotals = z.infer<typeof agentFeedbackTotalsSchema>;
