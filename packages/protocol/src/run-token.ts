import { z } from "zod";
import { uuidSchema } from "./common.js";

/**
 * Run-bound model-gateway tokens (KOBE-117, part of KOBE-73). CONTRACT ONLY: minting, delivery and
 * enforcement are KOBE-118.
 *
 * Why: the sandbox session token (session-token.ts) is per sandbox, and `x-kobe-run-id` is advisory
 * (anything in the sandbox that can read the token can call the gateway with any run id), so a
 * per-run budget stop (D30) cannot be enforced against a run's own tools. A run token is minted by
 * the server at `run.start`, bound to exactly one run, revoked at run end, and delivered only to
 * that thread's Pi (in `run.start.run_token`, never in a file or env var the tools can read).
 *
 * Wire: the model-gateway shim accepts it in the `x-kobe-run-token` request header
 * ({@link RUN_TOKEN_HEADER}). `Authorization: Bearer <session token>` stays as it is.
 *
 * Format: `krt1.<payload>.<mac>`; `payload` = base64url (no padding) of the UTF-8 JSON of
 * {@link RunTokenClaims}; `mac` = base64url HMAC-SHA256 over the ASCII string `krt1.<payload>`
 * (the exact received text, no re-serialisation). The HMAC key is derived, never the master key
 * itself: `HKDF-SHA256(ikm = server master secret, salt = empty, info = "kobe/run-token/v1", 32)`
 * (`deriveRunTokenKey` in `@kobe/protocol/node`), so it is domain-separated from the approval
 * and session-token keys. Algorithm and version are fixed by the `krt1` prefix, never read from
 * the token. The gateway holds the derived key only (it can verify and also mint: it is a server
 * side component, never in a sandbox).
 *
 * Verification (gateway, every request): size cap, prefix, constant-time MAC check, strict claims
 * parse, `now < exp`, `iat <= now + skew`, and then the stateful checks the token cannot carry:
 * the run is still active (revocation at run end; `jti` can name it in audit) and `sandbox_id`/
 * `team_id` match the session token on the same request. The run id used for attribution and
 * budget is `claims.run_id`; an `x-kobe-run-id` that disagrees is a 403.
 *
 * Rollout (old agents keep working): the server sends `run.start.run_token` only to agents whose
 * `hello.capabilities` lists {@link CAPABILITY_RUN_TOKEN}. Gateway order: (1) header present: it
 * must verify, else 401 with no fallback to the advisory header; (2) header absent: legacy
 * behaviour (session token plus advisory `x-kobe-run-id`), allowed until the operator turns on
 * enforcement (a gateway setting owned by KOBE-118), after which a missing header is a 401.
 * Roll out server, then gateway, then agents/images; enable enforcement once no sandbox without
 * the capability remains.
 */
export const CAPABILITY_RUN_TOKEN = "run_token";
export const RUN_TOKEN_HEADER = "x-kobe-run-token";
export const RUN_TOKEN_PREFIX = "krt1";
export const RUN_TOKEN_KDF_INFO = "kobe/run-token/v1";
export const RUN_TOKEN_KEY_BYTES = 32;
export const RUN_TOKEN_MASTER_MIN_BYTES = 32;
/** Longest token any verifier reads; larger input is rejected before parsing. */
export const RUN_TOKEN_MAX_CHARS = 1024;
/** Tolerated clock skew for `iat`, seconds. */
export const RUN_TOKEN_SKEW_SECONDS = 60;
/** Upper bound on `exp - iat` (24 h); KOBE-118 picks the real TTL under it. */
export const MAX_RUN_TOKEN_TTL_SECONDS = 24 * 60 * 60;

export const runTokenClaimsSchema = z
  .strictObject({
    iss: z.literal("kobe-server"),
    aud: z.literal("kobe.model-gateway"),
    run_id: uuidSchema,
    team_id: uuidSchema,
    sandbox_id: uuidSchema,
    /** Seconds since the epoch. */
    iat: z.number().int().positive(),
    exp: z.number().int().positive(),
    /** Unique token id (audit, revocation record). */
    jti: z.string().min(16).max(128),
  })
  .refine((c) => c.exp > c.iat && c.exp - c.iat <= MAX_RUN_TOKEN_TTL_SECONDS, {
    message: "exp must be after iat and within MAX_RUN_TOKEN_TTL_SECONDS",
    path: ["exp"],
  });
export type RunTokenClaims = z.infer<typeof runTokenClaimsSchema>;

/** The `run.start.run_token` field: the opaque token plus its expiry (informational for the agent). */
export const runTokenGrantSchema = z.strictObject({
  token: z.string().min(1).max(RUN_TOKEN_MAX_CHARS),
  /** RFC 3339; equals `claims.exp`. The agent never parses the token. */
  expires_at: z.iso.datetime({ offset: true }),
});
export type RunTokenGrant = z.infer<typeof runTokenGrantSchema>;

export type RunTokenFailure =
  "malformed" | "bad_mac" | "expired" | "not_yet_valid" | "wrong_audience";

export type VerifyRunTokenResult =
  | { readonly ok: true; readonly claims: RunTokenClaims }
  | { readonly ok: false; readonly reason: RunTokenFailure };
