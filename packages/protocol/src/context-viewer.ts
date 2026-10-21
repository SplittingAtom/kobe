import { z } from "zod";
import { timestampSchema, uuidSchema } from "./common.js";

/**
 * Context viewer (KOBE-470, docs/specs/context-viewer.md): what a thread's latest model call sent
 * the model, read live from the owner's sandbox and broken into ordered sections. Nothing of it is
 * stored: the server holds it only for the response. `GET /v1/threads/{id}/context` answers
 * {@link threadContextSchema} (200), {@link threadContextWakingSchema} (202 while the sandbox
 * wakes) or a {@link threadContextErrorSchema}.
 *
 * Every `text` is untrusted data (the model, tools, web pages and teammates' files wrote parts of
 * it): render it as plain text only, never as Markdown or HTML.
 */

/** What a section is, in the order the spec lists them (CV3). */
export const CONTEXT_SECTION_KINDS = [
  /** Pi's own prompt: preamble, tool guidance, rules, docs, working directory. */
  "system_prompt",
  /** The agent's instructions (Kobe's appended system prompt) and project instructions. */
  "agent_instructions",
  /** The skills index Pi lists in the prompt. */
  "skills",
  /** The saved-memory index (KOBE-157). */
  "memory",
  /** The file the member had open when sending (KOBE-462). */
  "viewing_file",
  /** One tool's definition (name, description, JSON schema). */
  "tool_definitions",
  "user_message",
  /** The model's text or thinking in an earlier answer. */
  "assistant_message",
  /** One tool call of an earlier answer (name and arguments). */
  "tool_call",
  "tool_result",
  /** Pi's summary of the history before a compaction. */
  "compaction_summary",
  /** Anything else Pi sent (a branch summary, a custom message, a prompt update). */
  "other",
] as const;
export const contextSectionKindSchema = z.enum(CONTEXT_SECTION_KINDS);
export type ContextSectionKind = z.infer<typeof contextSectionKindSchema>;

/** Longest section text, in UTF-16 code units; longer text is cut and ends with the marker. */
export const CONTEXT_SECTION_MAX_CHARS = 128 * 1024;
/** Room for {@link contextTruncationMarker} after a cut. */
export const CONTEXT_TRUNCATION_MARKER_MAX_CHARS = 100;
/**
 * Most sections in one answer. Past it the middle of the conversation is left out
 * (`omitted_sections`) and one `other` section, marked truncated, stands in for it.
 */
export const CONTEXT_MAX_SECTIONS = 4000;
/** Longest one-line label. */
export const CONTEXT_LABEL_MAX_CHARS = 200;

/** Appended to a cut section's text. */
export const contextTruncationMarker = (omittedChars: number): string =>
  `\n[… ${omittedChars} more characters not shown]`;

export const contextSectionSchema = z.strictObject({
  kind: contextSectionKindSchema,
  /** One line naming it: a prompt section's name, a tool's name, "Thinking", ... */
  label: z.string().max(CONTEXT_LABEL_MAX_CHARS),
  text: z.string().max(CONTEXT_SECTION_MAX_CHARS + CONTEXT_TRUNCATION_MARKER_MAX_CHARS),
  /** Tokens of the whole section (not only the shown part); see `tokens_basis`. */
  tokens: z.number().int().nonnegative(),
  /** Length of the whole section, in UTF-16 code units. */
  chars: z.number().int().nonnegative(),
  /** `text` was cut (it ends with the marker). */
  truncated: z.boolean(),
});
export type ContextSection = z.infer<typeof contextSectionSchema>;

/**
 * Where the sections come from (CV4): `model_call` the request the latest model call actually sent
 * (captured as it was sent); `session` rebuilt from the thread's Pi session because no call was
 * captured since the sandbox's Pi started (after a wake or a restart): exact for the conversation,
 * without the per-run memory, project instructions and viewed file; `none` no model call yet.
 */
export const CONTEXT_SOURCES = ["model_call", "session", "none"] as const;
export const contextSourceSchema = z.enum(CONTEXT_SOURCES);
export type ContextSource = z.infer<typeof contextSourceSchema>;

/**
 * How `tokens` were counted (CV5). No tokenizer runs in the sandbox, so each section is estimated
 * from its length; `usage`: the estimates are scaled so they add up to the call's reported prompt
 * tokens (input + cache read + cache write, the gauge's number); `estimate`: no usage was reported
 * (the call failed, or nothing was called), so the sum is the estimate itself.
 */
/**
 * What a `session` answer cannot hold (CV4): the per-run parts kobe-tools adds to the prompt never
 * reach the session, and the call's context window is not recorded there.
 */
export const CONTEXT_MISSING_PARTS = [
  "memory",
  "project_instructions",
  "viewing_file",
  "context_window",
] as const;
export const contextMissingPartSchema = z.enum(CONTEXT_MISSING_PARTS);

export const CONTEXT_TOKENS_BASES = ["usage", "estimate"] as const;
export const contextTokensBasisSchema = z.enum(CONTEXT_TOKENS_BASES);

/** What the sandbox answers (`thread.context` command result data), and the route's body less the thread. */
export const threadContextResultSchema = z.strictObject({
  source: contextSourceSchema,
  /**
   * The sections are what the call sent (`model_call`, or `none`). False for `session`: the web
   * labels it "Approximate — the sandbox restarted since the last model call".
   */
  exact: z.boolean(),
  /** What an approximate answer may lack (empty when exact). */
  missing: z.array(contextMissingPartSchema).max(CONTEXT_MISSING_PARTS.length),
  /** When the call was sent (`model_call`) or answered (`session`); null for `none`. */
  captured_at: timestampSchema.nullable(),
  /** The gateway model the call went to; null when unknown. */
  model: z.string().max(256).nullable(),
  /** That model's context window in tokens; null when unknown. */
  context_window: z.number().int().positive().nullable(),
  /** Sum of every section's tokens, the left-out ones included. */
  total_tokens: z.number().int().nonnegative(),
  tokens_basis: contextTokensBasisSchema,
  /** In the order the model saw them. */
  sections: z.array(contextSectionSchema).max(CONTEXT_MAX_SECTIONS),
  /** Some section was cut or left out to stay within the size cap. */
  truncated: z.boolean(),
  /** Sections left out of the middle (over the count cap); see {@link CONTEXT_MAX_SECTIONS}. */
  omitted_sections: z.number().int().nonnegative(),
});
export type ThreadContextResult = z.infer<typeof threadContextResultSchema>;

/** `GET /v1/threads/{id}/context` 200. */
export const threadContextSchema = threadContextResultSchema.extend({ thread_id: uuidSchema });
export type ThreadContext = z.infer<typeof threadContextSchema>;

/** 202: the sandbox was asleep and is waking; ask again after `retry_after_ms`. */
export const threadContextWakingSchema = z.strictObject({
  status: z.literal("waking"),
  retry_after_ms: z.number().int().positive(),
});
export type ThreadContextWaking = z.infer<typeof threadContextWakingSchema>;

/**
 * `not_owner`: a shared reader (only the owner sees the context, CV2). `thread_busy`: the thread's
 * session is being compacted or restored. `context_unsupported`: the sandbox's agent predates the
 * command (it is upgraded on its next start). `sandbox_unavailable`: retryable.
 * `context_unavailable`: the sandbox could not read it. `rate_limited`: too many reads in a minute.
 */
export const THREAD_CONTEXT_ERROR_CODES = [
  "not_owner",
  "thread_busy",
  "context_unsupported",
  "sandbox_unavailable",
  "context_unavailable",
  "rate_limited",
] as const;
export const threadContextErrorCodeSchema = z.enum(THREAD_CONTEXT_ERROR_CODES);
export type ThreadContextErrorCode = z.infer<typeof threadContextErrorCodeSchema>;

export const THREAD_CONTEXT_ERROR_HTTP_STATUS = {
  not_owner: 403,
  thread_busy: 409,
  context_unsupported: 409,
  sandbox_unavailable: 503,
  context_unavailable: 502,
  rate_limited: 429,
} as const satisfies Record<ThreadContextErrorCode, number>;

/** One fixed message per code: the sandbox's own error text is logged, never relayed. */
export const THREAD_CONTEXT_ERROR_MESSAGES = {
  not_owner: "Only the person who owns this conversation can see its context.",
  thread_busy: "This conversation is being compacted or restored. Try again in a moment.",
  context_unsupported:
    "Your workspace runs an older agent that can't show the context yet. It is updated the next time it starts.",
  sandbox_unavailable: "Your workspace is not available right now. Try again in a moment.",
  context_unavailable: "The context could not be read from your workspace. Try again.",
  rate_limited: "Too many context reads. Wait a moment and try again.",
} as const satisfies Record<ThreadContextErrorCode, string>;

const contextError = <C extends ThreadContextErrorCode>(code: C) =>
  z.strictObject({
    code: z.literal(code),
    message: z.literal(THREAD_CONTEXT_ERROR_MESSAGES[code]),
  });

export const threadContextErrorSchema = z.discriminatedUnion("code", [
  contextError("not_owner"),
  contextError("thread_busy"),
  contextError("context_unsupported"),
  contextError("sandbox_unavailable"),
  contextError("context_unavailable"),
  contextError("rate_limited"),
]);
export type ThreadContextError = z.infer<typeof threadContextErrorSchema>;

export const threadContextError = (code: ThreadContextErrorCode): ThreadContextError =>
  threadContextErrorSchema.parse({ code, message: THREAD_CONTEXT_ERROR_MESSAGES[code] });
