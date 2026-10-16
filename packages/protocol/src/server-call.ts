import { z } from "zod";
import { NO_CONTROL_CHARS, THREAD_TITLE_MAX, uuidSchema } from "./common.js";
import { gatewayModelSchema } from "./sandbox-wire/frames.js";

/**
 * Server-originated model calls (KOBE-234; CE18 auto-titles, CE21 follow-ups). After a run
 * completes, the server itself asks the thread's model for a title or three follow-ups. No sandbox
 * and no active run exist, so neither the session token nor the run token (run-token.ts) applies.
 * Design and rationale: docs/design/server-model-calls.md.
 *
 * Identity: a **server-call token**, minted by the server per call and sent to the model gateway in
 * the {@link SERVER_CALL_TOKEN_HEADER} header, alone (no session token, run token or advisory run
 * id on the same request). Format `ksc1.<payload>.<mac>`, as run tokens: `payload` = base64url (no
 * padding) of the UTF-8 JSON of {@link ServerCallClaims}; `mac` = base64url HMAC-SHA256 over the
 * ASCII `ksc1.<payload>`. Key: `HKDF-SHA256(ikm = the model-gateway session key, salt = empty,
 * info = "kobe/server-call-token/v1", 32)` (`deriveServerCallTokenKey` in `@kobe/protocol/node`):
 * domain-separated from the session-token, run-token and approval keys, so no token of one kind
 * verifies as another. Sandboxes hold none of these keys and never see a server-call token.
 *
 * The gateway (every request): size cap, prefix, constant-time MAC, strict claims, `now < exp`,
 * `iat <= now + skew`, the `jti` not seen before on this replica (single use per replica; across
 * replicas the token is bounded by its TTL, purpose, model and output cap; threat model in the
 * design doc), the member still active with a virtual key, the token's run a completed run of its
 * thread leased to its member, `model` enabled for the team, and then the body:
 * {@link serverCallRequestSchema} (Chat Completions, no tools, no streaming), `body.model ===
 * claims.model`, its output limit at most `claims.max_output_tokens`. Budgets are the same
 * reservation path as sandbox calls (`kobe_reserve_budget`, KOBE-120/286) for (team, user), plus
 * {@link SERVER_CALL_LIMITS}`[purpose].skip_at_percent`, which the gateway enforces too (402
 * `budget_soft_limit`; judged by the reservation at that percentage of each line), so a server
 * bug cannot spend past the rule. Usage is one `run_usage` row
 * with `kind = purpose`, no sandbox, `run_id = claims.run_id` (migration 0099).
 */
export const SERVER_CALL_PURPOSES = ["title", "followups"] as const;
export const serverCallPurposeSchema = z.enum(SERVER_CALL_PURPOSES);
export type ServerCallPurpose = z.infer<typeof serverCallPurposeSchema>;

export const SERVER_CALL_TOKEN_HEADER = "x-kobe-server-call";
export const SERVER_CALL_TOKEN_PREFIX = "ksc1";
export const SERVER_CALL_TOKEN_KDF_INFO = "kobe/server-call-token/v1";
/** The audience no other Kobe token carries (session and run tokens say `kobe.model-gateway`). */
export const SERVER_CALL_AUDIENCE = "kobe.model-gateway.server-call";
/** Longest token any verifier reads; larger input is rejected before parsing. */
export const SERVER_CALL_TOKEN_MAX_CHARS = 1024;
/** Tolerated clock skew for `iat`, seconds. */
export const SERVER_CALL_TOKEN_SKEW_SECONDS = 30;
/** Upper bound on `exp - iat`: a token is minted right before its one call. */
export const MAX_SERVER_CALL_TOKEN_TTL_SECONDS = 30;
/** The only gateway route a server call may use (Bifrost translates it for every provider). */
export const SERVER_CALL_PATH = "/v1/chat/completions";
/** Largest request body the gateway accepts on a server call. */
export const SERVER_CALL_MAX_BODY_BYTES = 64 * 1024;
export const SERVER_CALL_MAX_MESSAGES = 4;
/** Longest message text, in UTF-16 code units (the server truncates what it quotes). */
export const SERVER_CALL_MESSAGE_MAX_CHARS = 16_000;

/**
 * Per purpose: the hard output cap (the gateway refuses more whatever the token says), the
 * server's whole-call timeout (no retries; a failure is logged, never a run failure), and the
 * budget use at which the call is skipped: titles below 100 % (the ordinary budget stop),
 * follow-ups below 80 % (CE21). Percent of every budget line that applies to the call (site,
 * team, user-in-team; dollars or tokens; month or day).
 */
export const SERVER_CALL_LIMITS = {
  title: { max_output_tokens: 64, timeout_ms: 15_000, skip_at_percent: 100 },
  followups: { max_output_tokens: 256, timeout_ms: 20_000, skip_at_percent: 80 },
} as const satisfies Record<
  ServerCallPurpose,
  { max_output_tokens: number; timeout_ms: number; skip_at_percent: number }
>;

const MAX_OUTPUT_CAP = Math.max(
  ...SERVER_CALL_PURPOSES.map((p) => SERVER_CALL_LIMITS[p].max_output_tokens),
);

export const serverCallClaimsSchema = z
  .strictObject({
    iss: z.literal("kobe-server"),
    aud: z.literal(SERVER_CALL_AUDIENCE),
    purpose: serverCallPurposeSchema,
    team_id: uuidSchema,
    /**
     * Whose budget line and virtual key: the member whose run triggered the call. Also the trace's
     * `user.id` (opaque uuid; KOBE-274 sets the attribute on the gateway's span).
     */
    user_id: uuidSchema,
    /**
     * The thread: usage attribution, and the trace's `session.id` (Langfuse sessions group a
     * thread's model calls; KOBE-274 sets it on run calls and, from this claim, on server calls).
     */
    thread_id: uuidSchema,
    /** The completed run that triggered the call (usage attribution and tracing). */
    run_id: uuidSchema,
    /** `<gateway provider>/<model>`: the thread's resolved model (a pinned agent's model wins). */
    model: gatewayModelSchema,
    max_output_tokens: z.number().int().min(1).max(MAX_OUTPUT_CAP),
    /** Seconds since the epoch. */
    iat: z.number().int().positive(),
    exp: z.number().int().positive(),
    /** Unique token id (replay refusal, audit). */
    jti: z.string().min(16).max(128).regex(NO_CONTROL_CHARS),
  })
  .refine((c) => c.exp > c.iat && c.exp - c.iat <= MAX_SERVER_CALL_TOKEN_TTL_SECONDS, {
    message: "exp must be after iat and within MAX_SERVER_CALL_TOKEN_TTL_SECONDS",
    path: ["exp"],
  })
  .refine((c) => c.max_output_tokens <= SERVER_CALL_LIMITS[c.purpose].max_output_tokens, {
    message: "max_output_tokens is above the purpose's cap",
    path: ["max_output_tokens"],
  });
export type ServerCallClaims = z.infer<typeof serverCallClaimsSchema>;

export type ServerCallTokenFailure = "malformed" | "bad_mac" | "expired" | "not_yet_valid";

export type VerifyServerCallTokenResult =
  | { readonly ok: true; readonly claims: ServerCallClaims }
  | { readonly ok: false; readonly reason: ServerCallTokenFailure };

const outputLimit = z.number().int().min(1).max(MAX_OUTPUT_CAP);

/**
 * The request body a server call may send: an OpenAI Chat Completions subset. Strict, so tools,
 * functions, tool messages, images, audio, web search, logprobs, `n > 1` and streaming are all
 * refused by shape. Exactly one of `max_tokens` / `max_completion_tokens`.
 */
export const serverCallRequestSchema = z
  .strictObject({
    model: gatewayModelSchema,
    messages: z
      .array(
        z.strictObject({
          role: z.enum(["system", "user", "assistant"]),
          content: z.string().min(1).max(SERVER_CALL_MESSAGE_MAX_CHARS),
        }),
      )
      .min(1)
      .max(SERVER_CALL_MAX_MESSAGES),
    max_tokens: outputLimit.optional(),
    max_completion_tokens: outputLimit.optional(),
    temperature: z.number().min(0).max(2).optional(),
    stream: z.literal(false).optional(),
    n: z.literal(1).optional(),
    /** For reasoning models, so a small output cap is not spent on thinking. */
    reasoning_effort: z.enum(["none", "minimal", "low"]).optional(),
  })
  .refine((b) => (b.max_tokens === undefined) !== (b.max_completion_tokens === undefined), {
    message: "exactly one of max_tokens and max_completion_tokens",
  });
export type ServerCallRequest = z.infer<typeof serverCallRequestSchema>;

/** Longest generated title (well under {@link THREAD_TITLE_MAX}; the rail shows one line). */
export const GENERATED_TITLE_MAX_CHARS = 80;
/** A title the server writes after normalising the model's reply (one line, no quotes). */
export const generatedTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(Math.min(GENERATED_TITLE_MAX_CHARS, THREAD_TITLE_MAX))
  .regex(NO_CONTROL_CHARS);

export const THREAD_SUGGESTIONS_MAX = 3;
export const THREAD_SUGGESTION_MAX_CHARS = 120;
/** Follow-ups as the server keeps them: one line each, at most three. */
export const threadSuggestionsSchema = z
  .array(z.string().trim().min(1).max(THREAD_SUGGESTION_MAX_CHARS).regex(NO_CONTROL_CHARS))
  .min(1)
  .max(THREAD_SUGGESTIONS_MAX);

/**
 * Epilogue (events.ts): `run.completed.epilogue` lists the server calls the server will attempt
 * for that run; their results are appended to the same run's events after `run.completed`
 * (`thread.updated`, `thread.suggestions`). The event stream stays open until each announced
 * result arrived or this long after `run.completed`, whichever is first (sse.ts). A call that fails
 * or is skipped writes nothing.
 */
export const SERVER_CALL_EPILOGUE_MAX_MS = 30_000;
