import { createHmac, timingSafeEqual } from "node:crypto";
import {
  APPROVAL_KEY_MIN_BYTES,
  APPROVAL_MAC_ALGORITHM,
  APPROVAL_TOKEN_TTL_MS,
  APPROVAL_TOKEN_VERSION,
  approvalSigningBytes,
  approvalTokenSchema,
  type ApprovalBinding,
  type ApprovalStore,
  type ApprovalToken,
} from "../approval.js";

/**
 * Reference HMAC for approvals (Node only; import from `@kobe/protocol/node`). The server (KOBE-37)
 * signs; the executing enforcement point (MCP proxy, KOBE-58) verifies and consumes. Never import
 * this into sandbox code: the key must not exist there.
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
  binding: ApprovalBinding,
  input: unknown,
): string {
  return createHmac("sha256", secret)
    .update(approvalSigningBytes(binding, input))
    .digest("base64url");
}

export interface SignApprovalInput {
  readonly key: ApprovalKey;
  readonly approval_id: string;
  readonly team_id: string;
  readonly run_id: string;
  readonly tool_call_id: string;
  readonly tool: string;
  readonly input: unknown;
  /** Decision time; the token expires `APPROVAL_TOKEN_TTL_MS` later. */
  readonly now: Date;
}

export function signApproval(args: SignApprovalInput): ApprovalToken {
  assertKey(args.key);
  const binding: ApprovalBinding = {
    team_id: args.team_id,
    run_id: args.run_id,
    tool_call_id: args.tool_call_id,
    tool: args.tool,
    expires_at: new Date(args.now.getTime() + APPROVAL_TOKEN_TTL_MS).toISOString(),
  };
  return approvalTokenSchema.parse({
    v: APPROVAL_TOKEN_VERSION,
    alg: APPROVAL_MAC_ALGORITHM,
    kid: args.key.kid,
    approval_id: args.approval_id,
    ...binding,
    mac: computeApprovalMac(args.key.secret, binding, args.input),
  });
}

/** The call as the verifier sees it, from its own state — never from the token. */
export interface ExpectedCall {
  readonly team_id: string;
  readonly run_id: string;
  readonly tool_call_id: string;
  readonly tool: string;
}

export interface VerifyApprovalInput {
  /** Untrusted token as received. */
  readonly token: unknown;
  readonly expected: ExpectedCall;
  /** The input about to execute. */
  readonly input: unknown;
  readonly now: Date;
  readonly keyFor: (kid: string) => ApprovalKey | undefined;
}

export type VerifyFailure =
  | "malformed"
  | "unknown_key"
  | "binding_mismatch"
  | "expired"
  | "bad_mac"
  | "not_allowed"
  | "record_mismatch"
  | "run_inactive"
  | "already_consumed";

export type VerifyApprovalResult =
  | { readonly ok: true; readonly token: ApprovalToken }
  | { readonly ok: false; readonly reason: VerifyFailure };

function equalConstantTime(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Stateless half (see approval.ts). Fails closed on anything malformed or mismatched. */
export function verifyApproval(args: VerifyApprovalInput): VerifyApprovalResult {
  const parsed = approvalTokenSchema.safeParse(args.token);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  const token = parsed.data;
  const { expected } = args;
  if (
    token.team_id !== expected.team_id ||
    token.run_id !== expected.run_id ||
    token.tool_call_id !== expected.tool_call_id ||
    token.tool !== expected.tool
  ) {
    return { ok: false, reason: "binding_mismatch" };
  }
  const key = args.keyFor(token.kid);
  if (key === undefined) return { ok: false, reason: "unknown_key" };
  assertKey(key);
  if (!(args.now.getTime() < Date.parse(token.expires_at))) return { ok: false, reason: "expired" };
  let expectedMac: string;
  try {
    expectedMac = computeApprovalMac(key.secret, token, args.input);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!equalConstantTime(expectedMac, token.mac)) return { ok: false, reason: "bad_mac" };
  return { ok: true, token };
}

/** Both halves: stateless verification, then state checks and single-use consumption. */
export async function authorizeApprovedCall(
  args: VerifyApprovalInput & { readonly store: ApprovalStore },
): Promise<VerifyApprovalResult> {
  const verified = verifyApproval(args);
  if (!verified.ok) return verified;
  const { token } = verified;
  const record = await args.store.load(token.team_id, token.approval_id);
  if (record === undefined || record.status !== "allowed")
    return { ok: false, reason: "not_allowed" };
  if (
    record.team_id !== token.team_id ||
    record.run_id !== token.run_id ||
    record.tool_call_id !== token.tool_call_id ||
    record.input_hmac === null ||
    !equalConstantTime(record.input_hmac, token.mac)
  ) {
    return { ok: false, reason: "record_mismatch" };
  }
  if (!record.run_active) return { ok: false, reason: "run_inactive" };
  if (!(await args.store.consume(token.team_id, token.approval_id))) {
    return { ok: false, reason: "already_consumed" };
  }
  return verified;
}
