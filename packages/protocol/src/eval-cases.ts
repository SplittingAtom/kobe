import { z } from "zod";
import { idSchema, timestampSchema, uuidSchema } from "./common.js";
import { feedbackReasonSchema } from "./feedback.js";

/**
 * Shared eval cases (KOBE-276). CONTRACT: a member who rated an answer down may share that
 * exchange with the agent's owner as an eval case, after a preview of exactly what is shared.
 * Accepted cases join the agent's pre-publish Orbit eval (KOBE-93) as an extra suite.
 *
 * - **Consent:** nothing is shared without the preview step. The share request carries the
 *   preview's `digest`; the server rebuilds the copy with the same options and refuses
 *   (`preview_stale`) when it differs, so what is stored is exactly what the member saw.
 * - **A copy:** the case holds the prompt, the answer, the reasons and comment, and, only when the
 *   member ticks them, earlier turns, tool outputs and the names of attached files (never their
 *   bytes). It keeps no link into the conversation: it survives the thread's deletion, and reading
 *   it never reads the thread.
 * - **Who:** only the conversation's owner shares its exchanges (their own words), from their own
 *   thumbs down, on a team or personal agent (gallery agents have no owner in the team). The
 *   agent's owner reviews; the sharer is never shown to them (no user, and the day only).
 * - **Withdrawal** deletes the copy (always 204). Retention, legal hold, offboarding and team
 *   deletion cover it; a hold is never revealed.
 *
 * Routes (server):
 * - `POST /v1/runs/{run_id}/eval-case/preview` ({@link evalCaseOptionsSchema}) → {@link EvalCasePreview}
 * - `POST /v1/runs/{run_id}/eval-case` ({@link shareEvalCaseBodySchema}) → 201 {@link MyEvalCase}
 * - `GET /v1/eval-cases` → {@link MyEvalCases} (the caller's own shares in the active team)
 * - `DELETE /v1/eval-cases/{case_id}` → 204 (withdraw; also when there is none)
 * - `GET /v1/agents/{agent_id}/eval-cases` → {@link AgentEvalCases} (the agent's owner)
 * - `GET /v1/agents/{agent_id}/eval-cases/{case_id}` → {@link AgentEvalCase}
 * - `PATCH /v1/agents/{agent_id}/eval-cases/{case_id}` ({@link reviewEvalCaseBodySchema}) → {@link AgentEvalCase}
 */

/** `open`: waiting for review; `accepted`: in the agent's eval suite; `dismissed`: kept, not run. */
export const EVAL_CASE_STATUSES = ["open", "accepted", "dismissed"] as const;
export const evalCaseStatusSchema = z.enum(EVAL_CASE_STATUSES);
export type EvalCaseStatus = z.infer<typeof evalCaseStatusSchema>;

/** Longest prompt and answer copied, in characters (longer ones are cut, `truncated`). */
export const EVAL_CASE_TEXT_MAX_CHARS = 6_000;
/** Earlier exchanges (a prompt and its answer each) a member may add. */
export const EVAL_CASE_MAX_EARLIER_EXCHANGES = 2;
/** Longest earlier turn copied, in characters. */
export const EVAL_CASE_EARLIER_MAX_CHARS = 1_500;
/** Tool outputs a member may tick, and the longest one copied. */
export const EVAL_CASE_MAX_TOOL_OUTPUTS = 4;
export const EVAL_CASE_TOOL_OUTPUT_MAX_CHARS = 1_500;
/** Attached files a member may name in the copy (names, types and sizes only). */
export const EVAL_CASE_MAX_ATTACHMENTS = 10;
/** Longest expected behaviour (or rubric) an owner writes. */
export const EVAL_CASE_EXPECTED_MAX_CHARS = 2_000;
/** Accepted cases per agent: each runs on every gated publish. */
export const EVAL_CASE_MAX_ACCEPTED = 20;
/** Characters of the prompt in an owner's list. */
export const EVAL_CASE_EXCERPT_CHARS = 200;

const distinct = <T>(values: readonly T[]) => new Set(values).size === values.length;

/** What the member adds beyond the prompt, the answer and the rating (all off by default). */
export const evalCaseOptionsSchema = z.strictObject({
  earlier_exchanges: z.number().int().min(0).max(EVAL_CASE_MAX_EARLIER_EXCHANGES).default(0),
  /** Tool calls (their `tool_call_id`) of this answer whose output goes into the copy. */
  tool_output_ids: z
    .array(idSchema)
    .max(EVAL_CASE_MAX_TOOL_OUTPUTS)
    .refine(distinct, "tool outputs must be distinct")
    .default([]),
  /** Files attached to the prompt whose names go into the copy. */
  attachment_ids: z
    .array(uuidSchema)
    .max(EVAL_CASE_MAX_ATTACHMENTS)
    .refine(distinct, "attachments must be distinct")
    .default([]),
});
export type EvalCaseOptions = z.infer<typeof evalCaseOptionsSchema>;

/** Hex SHA-256 of the canonical JSON (RFC 8785) of the preview's `content`. */
export const evalCaseDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** `POST /v1/runs/{run_id}/eval-case`: the options previewed and the preview's digest. */
export const shareEvalCaseBodySchema = evalCaseOptionsSchema.extend({
  digest: evalCaseDigestSchema,
});
export type ShareEvalCaseBody = z.infer<typeof shareEvalCaseBodySchema>;

/** The copied exchange, exactly as stored and as the agent's owner sees it. */
export const evalCaseContentSchema = z.strictObject({
  prompt: z.string(),
  answer: z.string(),
  /** Earlier turns, oldest first (only when the member added them). */
  earlier: z.array(z.strictObject({ role: z.enum(["user", "assistant"]), text: z.string() })),
  /** Ticked tool outputs, in call order. */
  tool_outputs: z.array(
    z.strictObject({ tool: z.string(), text: z.string(), is_error: z.boolean() }),
  ),
  /** Ticked attachments: names, types and sizes, never the files. */
  attachments: z.array(
    z.strictObject({
      name: z.string(),
      mime_type: z.string(),
      size_bytes: z.number().int().nonnegative(),
    }),
  ),
  reasons: z.array(feedbackReasonSchema),
  comment: z.string().nullable(),
  /** Some text was cut to the limits above (or was too large to read back). */
  truncated: z.boolean(),
});
export type EvalCaseContent = z.infer<typeof evalCaseContentSchema>;

const agentRefSchema = z.strictObject({
  scope: z.enum(["team", "personal"]),
  id: uuidSchema,
  /** The published version that answered (null: unknown, e.g. after compaction). */
  version: z.number().int().positive().nullable(),
});

/** `POST /v1/runs/{run_id}/eval-case/preview`: what sharing with these options would store. */
export const evalCasePreviewSchema = z.strictObject({
  run_id: uuidSchema,
  agent: agentRefSchema,
  content: evalCaseContentSchema,
  digest: evalCaseDigestSchema,
  /** What the member can add (for the ticks). */
  available: z.strictObject({
    earlier_exchanges: z.number().int().min(0).max(EVAL_CASE_MAX_EARLIER_EXCHANGES),
    tool_outputs: z.array(
      z.strictObject({ id: idSchema, tool: z.string(), is_error: z.boolean() }),
    ),
    attachments: z.array(
      z.strictObject({
        id: uuidSchema,
        name: z.string(),
        mime_type: z.string(),
        size_bytes: z.number().int().nonnegative(),
      }),
    ),
  }),
  /** This rating is already shared (withdraw it first to share again). */
  shared_case_id: uuidSchema.nullable(),
});
export type EvalCasePreview = z.infer<typeof evalCasePreviewSchema>;

/** A member's own shared case. */
export const myEvalCaseSchema = z.strictObject({
  id: uuidSchema,
  agent: agentRefSchema,
  status: evalCaseStatusSchema,
  content: evalCaseContentSchema,
  shared_at: timestampSchema,
});
export type MyEvalCase = z.infer<typeof myEvalCaseSchema>;

export const myEvalCasesSchema = z.strictObject({ cases: z.array(myEvalCaseSchema) });
export type MyEvalCases = z.infer<typeof myEvalCasesSchema>;

/** A case as the agent's owner sees it in the list: no sharer, the day only. */
export const agentEvalCaseSummarySchema = z.strictObject({
  id: uuidSchema,
  status: evalCaseStatusSchema,
  agent_version: z.number().int().positive().nullable(),
  reasons: z.array(feedbackReasonSchema),
  prompt_excerpt: z.string(),
  /** UTC day the case was shared (`YYYY-MM-DD`), never the time. */
  shared_on: z.iso.date(),
  expected_behaviour: z.string().nullable(),
  reviewed_at: timestampSchema.nullable(),
});
export type AgentEvalCaseSummary = z.infer<typeof agentEvalCaseSummarySchema>;

export const agentEvalCasesSchema = z.strictObject({
  agent_id: uuidSchema,
  accepted: z.number().int().nonnegative(),
  max_accepted: z.number().int().positive(),
  cases: z.array(agentEvalCaseSummarySchema),
});
export type AgentEvalCases = z.infer<typeof agentEvalCasesSchema>;

export const agentEvalCaseSchema = agentEvalCaseSummarySchema.extend({
  content: evalCaseContentSchema,
});
export type AgentEvalCase = z.infer<typeof agentEvalCaseSchema>;

/** Printable text plus newlines and tabs (as a feedback comment). */
// eslint-disable-next-line no-control-regex
const TEXT_CHARS = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u;

export const expectedBehaviourSchema = z
  .string()
  .trim()
  .min(1)
  .max(EVAL_CASE_EXPECTED_MAX_CHARS)
  .regex(TEXT_CHARS, "no control characters");

/**
 * `PATCH /v1/agents/{agent_id}/eval-cases/{case_id}`: accept (needs an expected behaviour, given
 * here or already stored), dismiss, reopen, or edit the expected behaviour. `null` clears it
 * (refused for an accepted case).
 */
export const reviewEvalCaseBodySchema = z
  .strictObject({
    status: evalCaseStatusSchema.optional(),
    expected_behaviour: expectedBehaviourSchema.nullable().optional(),
  })
  .refine((b) => b.status !== undefined || b.expected_behaviour !== undefined, {
    message: "change the status or the expected behaviour",
  });
export type ReviewEvalCaseBody = z.infer<typeof reviewEvalCaseBodySchema>;

/** Error codes of the eval case routes, with their HTTP status. */
export const EVAL_CASE_ERROR_HTTP_STATUS = {
  invalid_request: 400,
  run_not_found: 404,
  case_not_found: 404,
  agent_not_found: 404,
  forbidden: 403,
  /** Not the conversation's owner, no thumbs down of theirs, or a gallery or unknown agent. */
  not_shareable: 409,
  /** The conversation is in Trash, or is a builder test thread. */
  thread_unavailable: 409,
  /** The run's prompt is not recorded (yet). */
  exchange_unavailable: 409,
  already_shared: 409,
  /** What would be stored differs from the preview: preview again. */
  preview_stale: 409,
  /** Accepting needs an expected behaviour. */
  expected_behaviour_required: 409,
  /** The agent already has {@link EVAL_CASE_MAX_ACCEPTED} accepted cases. */
  case_limit: 409,
} as const;
export type EvalCaseErrorCode = keyof typeof EVAL_CASE_ERROR_HTTP_STATUS;

/**
 * How the cases count in the pre-publish gate (KOBE-93), stored on the eval and in its report:
 * every accepted case runs once; a case fails when the judge finds the new answer does not show
 * the expected behaviour. `failure_rate` = failed / scored is held to the team's threshold, like
 * the attack success rate; either above it blocks. A case that can't be scored errors the eval
 * (fail closed). Ids only: no case text is in an eval's report.
 */
export const evalCaseSuiteResultSchema = z.strictObject({
  cases: z.number().int().nonnegative(),
  scored: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  failure_rate: z.number().min(0).max(1).nullable(),
});
export type EvalCaseSuiteResult = z.infer<typeof evalCaseSuiteResultSchema>;
