import { FEEDBACK_COMMENT_MAX_CHARS, FEEDBACK_REASONS, type FeedbackReason } from "@kobe/protocol";

/**
 * Answer feedback in the chat (KOBE-275), camelized from `@kobe/protocol` feedback.ts: a member's
 * thumbs up or down on one answer (one run), reasons and a short comment on a thumbs down. Each
 * member sees and changes only their own rating, readers of a shared thread included.
 */

export { FEEDBACK_COMMENT_MAX_CHARS, FEEDBACK_REASONS, type FeedbackReason };

export type FeedbackRating = "up" | "down";

export interface AnswerFeedback {
  readonly runId: string;
  readonly threadId: string;
  readonly entryId: string | null;
  readonly rating: FeedbackRating;
  readonly reasons: readonly FeedbackReason[];
  readonly comment: string | null;
  readonly updatedAt: string;
}

/** `GET /v1/threads/{id}/feedback`: the rateable answers by prompt, with the caller's rating. */
export interface ThreadFeedback {
  readonly threadId: string;
  readonly answers: readonly {
    readonly runId: string;
    readonly userEntryId: string | null;
    readonly feedback: AnswerFeedback | null;
    /** The member shared this rating as an eval case (KOBE-276); absent on older servers. */
    readonly evalCaseId?: string | null;
  }[];
}

/** `PUT /v1/runs/{id}/feedback`'s body. */
export interface FeedbackChange {
  readonly rating: FeedbackRating;
  readonly reasons?: readonly FeedbackReason[];
  readonly comment?: string | null;
  readonly entryId?: string | null;
}

/** The chips' labels, in the contract's order. */
export const REASON_LABELS: Readonly<Record<FeedbackReason, string>> = {
  wrong: "Wrong or made up",
  ignored_instructions: "Didn't follow instructions",
  unsafe: "Unsafe",
  too_slow: "Too slow",
  other: "Other",
};

/** The wire body of a change (snake_case; reasons and comment only with a thumbs down). */
export function feedbackBody(change: FeedbackChange): Record<string, unknown> {
  const comment = change.comment?.trim() ?? "";
  return {
    rating: change.rating,
    ...(change.rating === "down" && change.reasons && change.reasons.length > 0
      ? { reasons: [...change.reasons] }
      : {}),
    ...(change.rating === "down" && comment !== "" ? { comment } : {}),
    ...(change.entryId ? { entry_id: change.entryId } : {}),
  };
}
