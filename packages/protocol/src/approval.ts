import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { idSchema, uuidSchema } from "./common.js";

/**
 * Approval signing (D29). The server signs every allowed approval so that exactly the approved call
 * runs, once: `mac = base64url(HMAC-SHA256(key, signing_bytes))` where
 *
 *     signing_bytes = UTF-8( canonicalJson([
 *       APPROVAL_SIGNING_DOMAIN, team_id, run_id, tool_call_id, tool, expires_at, input ]) )
 *
 * - D29 names (run_id, tool_call_id, canonical input); the tuple adds `tool` (a token for
 *   `get_issue` must not authorise `delete_issue` with the same ids), `team_id` (defence in depth
 *   across teams) and `expires_at` (a token is short-lived).
 * - `canonicalJson` is the RFC 8785 rule in canonical-json.ts. One canonical JSON array makes the
 *   encoding injective; the domain tag stops a MAC being replayed as any other Kobe HMAC. Changing
 *   the tuple or the tag is a contract change.
 * - `input` is the tool input as decided, validated by `toolInputSchema`. **The executor forwards
 *   exactly `JSON.parse(canonicalJson(input))`** — never the original object or text — so executed
 *   bytes equal signed bytes. Verifiers recompute the bytes from the input they are about to run.
 * - The key never enters a sandbox. Sign: server (KOBE-37). Verify + consume: the enforcement point
 *   that executes the call — the MCP proxy for MCP tools (KOBE-58). For Pi built-ins and kobe tools
 *   the server's `policy.result` is itself the authorisation (no token is needed in the sandbox).
 *
 * Verification is normative and has two halves; a call runs only if both pass:
 * 1. **Stateless** (`verifyApproval` in `@kobe/protocol/node`): token schema; `kid` known; token
 *    (team, run, tool_call_id, tool) equal the verifier's own view of the call; `now < expires_at`;
 *    MAC over the input about to run matches (constant time).
 * 2. **Stateful** (`authorizeApprovedCall`, against an {@link ApprovalStore}): the `approvals` row
 *    exists for this team with status `allowed` (not pending/denied/expired), its run/tool_call ids
 *    and `input_hmac` equal the token's; the run is still active (`running`/`waiting_approval`); and
 *    the approval is **consumed exactly once** (atomic `consumed_at IS NULL → now()`). A second use
 *    of the same approval — same or different tool_call_id — is rejected.
 */

export const APPROVAL_SIGNING_DOMAIN = "kobe.approval.v1";
export const APPROVAL_TOKEN_VERSION = 1;
export const APPROVAL_MAC_ALGORITHM = "HS256";
/** Minimum HMAC key length in bytes (RFC 2104 §3: at least the hash output length). */
export const APPROVAL_KEY_MIN_BYTES = 32;
/** Pending approvals expire after one hour (D29); on expiry the call is denied. */
export const APPROVAL_TTL_MS = 60 * 60 * 1000;
/** SPECULATIVE (KOBE-37 may tune): lifetime of a signed token from the moment of `allow`. */
export const APPROVAL_TOKEN_TTL_MS = 10 * 60 * 1000;

/** `Date.prototype.toISOString()` form, so every signer writes `expires_at` identically. */
const isoMillisSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

export interface ApprovalBinding {
  readonly team_id: string;
  readonly run_id: string;
  readonly tool_call_id: string;
  /** Tool name as Pi sees it, e.g. `mcp__jira__create_issue`. */
  readonly tool: string;
  readonly expires_at: string;
}

/** The canonical signing string (before UTF-8). Throws `CanonicalJsonError` on bad input. */
export function approvalSigningString(binding: ApprovalBinding, input: unknown): string {
  return canonicalJson([
    APPROVAL_SIGNING_DOMAIN,
    binding.team_id,
    binding.run_id,
    binding.tool_call_id,
    binding.tool,
    binding.expires_at,
    input,
  ]);
}

/** The exact bytes the HMAC is computed over. */
export function approvalSigningBytes(binding: ApprovalBinding, input: unknown): Uint8Array {
  return new TextEncoder().encode(approvalSigningString(binding, input));
}

/**
 * A signed approval, server → sandbox in `policy.result` and on to the enforcement point. `kid`
 * selects the key (rotation) and `approval_id` locates the row; neither is signed (both are checked
 * against state). Everything else except `mac` is in the signed tuple.
 */
export const approvalTokenSchema = z.strictObject({
  v: z.literal(APPROVAL_TOKEN_VERSION),
  alg: z.literal(APPROVAL_MAC_ALGORITHM),
  kid: z.string().min(1).max(64),
  approval_id: uuidSchema,
  team_id: uuidSchema,
  run_id: uuidSchema,
  tool_call_id: idSchema,
  tool: z.string().min(1).max(256),
  expires_at: isoMillisSchema,
  mac: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type ApprovalToken = z.infer<typeof approvalTokenSchema>;

/** What a verifier knows about an `approvals` row (KOBE-37 owns storage). */
export interface ApprovalRecord {
  readonly approval_id: string;
  readonly team_id: string;
  readonly run_id: string;
  readonly tool_call_id: string;
  /** `approvals.status` (spec §5.4). */
  readonly status: "pending" | "allowed" | "denied" | "expired";
  /** `approvals.input_hmac`: the token's `mac`, stored when the approval was allowed. */
  readonly input_hmac: string | null;
  /** Whether the run is `running` or `waiting_approval` right now. */
  readonly run_active: boolean;
}

/**
 * State the verifier needs. Implementations run under `withTeam(team_id)`. KOBE-37 adds the
 * `approvals.consumed_at` column that `consume` sets atomically.
 */
export interface ApprovalStore {
  load(teamId: string, approvalId: string): Promise<ApprovalRecord | undefined>;
  /** `UPDATE approvals SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL`; true if 1 row. */
  consume(teamId: string, approvalId: string): Promise<boolean>;
}

/**
 * SPECULATIVE (KOBE-58 decides): where an MCP `tools/call` request carries the token to the MCP
 * proxy (`params._meta`), if Pi's MCP client can attach it.
 */
export const APPROVAL_TOKEN_MCP_META_KEY = "kobe.dev/approval";
