import { createHmac, timingSafeEqual } from "node:crypto";
import {
  APPROVAL_KEY_MIN_BYTES,
  APPROVAL_MAC_ALGORITHM,
  APPROVAL_TOKEN_VERSION,
  approvalSigningBytes,
  approvalTokenSchema,
  type ApprovalToken,
} from "../approval.js";

/**
 * Reference HMAC for approvals (Node only; import from `@kobe/protocol/node`). The server (KOBE-37)
 * signs; the server and the MCP proxy (KOBE-58) verify. Never import this into sandbox code: the
 * key must not exist there.
 */

export interface ApprovalKey {
  readonly kid: string;
  readonly secret: Uint8Array;
}

function assertKey(key: ApprovalKey): void {
  if (key.secret.byteLength < APPROVAL_KEY_MIN_BYTES) {
    throw new Error(`approval key ${key.kid} is shorter than ${APPROVAL_KEY_MIN_BYTES} bytes`);
  }
}

/** base64url (no padding) HMAC-SHA256 over the approval signing bytes. */
export function computeApprovalMac(
  secret: Uint8Array,
  runId: string,
  toolCallId: string,
  input: unknown,
): string {
  return createHmac("sha256", secret)
    .update(approvalSigningBytes(runId, toolCallId, input))
    .digest("base64url");
}

export interface SignApprovalInput {
  readonly key: ApprovalKey;
  readonly approval_id: string;
  readonly run_id: string;
  readonly tool_call_id: string;
  readonly input: unknown;
}

export function signApproval(args: SignApprovalInput): ApprovalToken {
  assertKey(args.key);
  return approvalTokenSchema.parse({
    v: APPROVAL_TOKEN_VERSION,
    alg: APPROVAL_MAC_ALGORITHM,
    kid: args.key.kid,
    approval_id: args.approval_id,
    run_id: args.run_id,
    tool_call_id: args.tool_call_id,
    mac: computeApprovalMac(args.key.secret, args.run_id, args.tool_call_id, args.input),
  });
}

export interface VerifyApprovalInput {
  /** Untrusted token as received. */
  readonly token: unknown;
  /** The run and call the verifier is about to execute (from its own state, not the token). */
  readonly run_id: string;
  readonly tool_call_id: string;
  /** The input about to execute. */
  readonly input: unknown;
  readonly keyFor: (kid: string) => ApprovalKey | undefined;
}

export type VerifyApprovalResult =
  | { readonly ok: true; readonly token: ApprovalToken }
  | {
      readonly ok: false;
      readonly reason: "malformed" | "unknown_key" | "binding_mismatch" | "bad_mac";
    };

/** Constant-time verification. Fails closed on every malformed or mismatched input. */
export function verifyApproval(args: VerifyApprovalInput): VerifyApprovalResult {
  const parsed = approvalTokenSchema.safeParse(args.token);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  const token = parsed.data;
  if (token.run_id !== args.run_id || token.tool_call_id !== args.tool_call_id) {
    return { ok: false, reason: "binding_mismatch" };
  }
  const key = args.keyFor(token.kid);
  if (key === undefined) return { ok: false, reason: "unknown_key" };
  assertKey(key);
  let expected: string;
  try {
    expected = computeApprovalMac(key.secret, args.run_id, args.tool_call_id, args.input);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(token.mac, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad_mac" };
  return { ok: true, token };
}
