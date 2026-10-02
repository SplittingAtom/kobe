import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { idSchema } from "./common.js";

/**
 * Approval signing (D29). The server signs every allowed approval so that exactly the approved input
 * runs: `mac = HMAC-SHA256(key, signing_bytes)` where
 *
 *     signing_bytes = UTF-8( canonicalJson([APPROVAL_SIGNING_DOMAIN, run_id, tool_call_id, input]) )
 *
 * - `canonicalJson` is the RFC 8785 rule in canonical-json.ts (sorted keys, ES number form, no
 *   Unicode normalisation, lone surrogates rejected).
 * - Wrapping the triple in one canonical JSON array makes the encoding injective (no delimiter
 *   ambiguity between ids and input) and the domain tag stops a MAC from being replayed as any other
 *   Kobe HMAC. Bumping the tag (`kobe.approval.v2`) is a contract change.
 * - `input` is the tool input **as it will execute** (after any argument rewriting), parsed from
 *   JSON. Verifiers recompute the bytes from the input they are about to run; they never trust a
 *   hash sent alongside it.
 * - The key never enters a sandbox (secrets rule). Verifiers are the server and the MCP proxy; the
 *   sandbox only carries the token.
 * - `mac` is base64url without padding (43 chars for SHA-256). Comparison must be constant-time.
 *
 * The reference sign/verify implementation is `@kobe/protocol/node` (node:crypto); this module is
 * pure so the web app can import the token type.
 */

export const APPROVAL_SIGNING_DOMAIN = "kobe.approval.v1";
export const APPROVAL_TOKEN_VERSION = 1;
export const APPROVAL_MAC_ALGORITHM = "HS256";
/** Minimum HMAC key length in bytes (32 = SHA-256 block-size guidance, RFC 2104 §3). */
export const APPROVAL_KEY_MIN_BYTES = 32;
/** Pending approvals expire after one hour (D29); on expiry the call is denied. */
export const APPROVAL_TTL_MS = 60 * 60 * 1000;

/** The canonical signing string (before UTF-8 encoding). Throws `CanonicalJsonError` on bad input. */
export function approvalSigningString(runId: string, toolCallId: string, input: unknown): string {
  return canonicalJson([APPROVAL_SIGNING_DOMAIN, runId, toolCallId, input]);
}

/** The exact bytes the HMAC is computed over. */
export function approvalSigningBytes(
  runId: string,
  toolCallId: string,
  input: unknown,
): Uint8Array {
  return new TextEncoder().encode(approvalSigningString(runId, toolCallId, input));
}

/**
 * A signed approval as it travels server → sandbox (in `policy.result`) and, where the MCP proxy
 * needs it, sandbox → MCP proxy. `kid` selects the server key (rotation); it is not signed.
 * `approval_id` links to the `approvals` row; it is not signed either (the row is looked up and must
 * itself carry the same `input_hmac`).
 */
export const approvalTokenSchema = z.object({
  v: z.literal(APPROVAL_TOKEN_VERSION),
  alg: z.literal(APPROVAL_MAC_ALGORITHM),
  kid: z.string().min(1).max(64),
  approval_id: idSchema,
  run_id: idSchema,
  tool_call_id: idSchema,
  mac: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type ApprovalToken = z.infer<typeof approvalTokenSchema>;

/**
 * SPECULATIVE (KOBE-58 decides): where an MCP `tools/call` request carries the token to the MCP
 * proxy, if Pi's MCP client can attach it. Otherwise the proxy looks the approval up by
 * (run, input HMAC) itself.
 */
export const APPROVAL_TOKEN_MCP_META_KEY = "kobe.dev/approval";
